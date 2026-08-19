// Diagnostics (D40): the three questions a failing run raises, answered from
// what the run already wrote down.
//
// The occasion was a fan-out that failed four evenings running, every time on
// the same sentence — "<model> returned an empty response" — which names the
// one fact the reader already had. These tests pin the part that matters: that
// the report points at a NEXT STEP, and that it never invents one when the
// evidence is not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { explainRun, probeModel, modelsInFlow } from '../core/diagnostics.js';
import { registerProvider } from '../core/adapters/index.js';
import { makeStore } from './helpers.js';

// A run built by hand, so the report is tested against known evidence rather
// than against whatever a live model happened to do.
function seedRun(store, { meta = {}, log = [], calls = {} } = {}) {
  const runId = store.createRun('a prompt');
  store.writeMeta(runId, { ...store.readMeta(runId), ...meta });
  for (const entry of log) store.appendLog(runId, entry);
  for (const [node, records] of Object.entries(calls)) {
    for (const r of records) store.writeCallTrace(runId, node, r);
  }
  return runId;
}

test('a truncated node is diagnosed as a budget problem, with the budget named', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', flowName: 'Learn from a repo', error: 'Node read failed', nodeStatus: { read: 'failed' } },
    log: [{ event: 'node_start', node: 'read', role: 'analyze', worker: { provider: 'openrouter', model: 'deepseek/x' } },
      { event: 'node_error', node: 'read', role: 'analyze', error: 'openrouter/deepseek/x returned no content' }],
    calls: {
      read: [{ ok: true, provider: 'openrouter', model: 'deepseek/x', maxTokens: 4096, finishReason: 'length', contentChars: 0, reasoningChars: 18503, ms: 69000 }]
    }
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'failed');
  const node = r.nodes.find(n => n.node === 'read');
  assert.equal(node.calls.truncated, 1);
  assert.equal(node.calls.reasoningShare, 100);
  assert.ok(r.suggestions.some(s => /finish_reason "length"/.test(s) && /4096/.test(s)),
    'the suggestion must name the budget that was hit');
});

test('rate limiting is called rate limiting, not a model problem', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', nodeStatus: { step: 'failed' } },
    log: [
      { event: 'node_start', node: 'step', role: 'execute' },
      ...Array.from({ length: 4 }, () => ({ event: 'model_retry', node: 'step', attempt: 1, error: 'OpenRouter API 429' })),
      { event: 'node_error', node: 'step', error: 'OpenRouter API 429: rate limited' }
    ],
    calls: { step: [{ ok: false, provider: 'openrouter', model: 'm', error: 'OpenRouter API 429', ms: 900 }] }
  });

  const r = explainRun(store, runId);
  assert.ok(r.suggestions.some(s => /transient retries/.test(s) && /throttling/.test(s)));
});

// The failure mode a diagnostic tool must not have: confident nonsense about a
// run whose evidence was never recorded. Every run made before the black box
// existed is in this state, and reading "no trace" as "no calls" would tell the
// reader to go looking upstream of a provider that was in fact called.
test('a run with no call trace says so instead of guessing', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'failed', nodeStatus: { step: 'failed' } },
    log: [{ event: 'node_start', node: 'step' },
      { event: 'node_error', node: 'step', error: 'openrouter/m returned an empty response' }]
  });

  const r = explainRun(store, runId);
  const node = r.nodes.find(n => n.node === 'step');
  assert.equal(node.traced, false);
  assert.ok(r.suggestions.some(s => /predates the model-call black box/.test(s)));
  assert.ok(!r.suggestions.some(s => /failed before any model call was made/.test(s)),
    'must not claim no call was made when it only means no record was kept');
});

// A node mid-agent-loop legitimately produces turns with no prose in them. The
// share is computed over ANSWERING turns only, so a healthy run being watched
// does not report itself as pathological.
test('tool-calling turns do not count as "all reasoning, no answer"', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'execution', nodeStatus: { orient: 'active' } },
    log: [{ event: 'node_start', node: 'orient', role: 'orient' }],
    calls: {
      orient: Array.from({ length: 5 }, () => ({
        ok: true, provider: 'openrouter', model: 'm', finishReason: 'tool_calls',
        contentChars: 0, reasoningChars: 1500, ms: 6000
      }))
    }
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'still running');
  const node = r.nodes.find(n => n.node === 'orient');
  assert.equal(node.calls.reasoningShare, null, 'no answering turn yet — no share to report');
  assert.deepEqual(r.suggestions, [], 'a healthy loop mid-flight has nothing to suggest');
});

// The command exists to be usable on the run you are staring at, which is the
// one still going. meta.nodeStatus lags behind a node deep in an agent loop, so
// the in-flight view is derived from the log.
test('a live run reports which node is in flight and for how long', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'execution', nodeStatus: { input: 'done', read: 'pending' } },
    log: [
      { event: 'node_start', node: 'input' },
      { event: 'node_start', node: 'read', role: 'analyze' }
    ]
  });

  const r = explainRun(store, runId);
  const read = r.nodes.find(n => n.node === 'read');
  assert.ok(read.inFlight);
  assert.ok(read.runningForMs >= 0);
  // The input node is done in meta, so it must not be reported as running
  // merely because it emitted no terminal event of its own.
  assert.ok(!r.nodes.some(n => n.node === 'input'));
});

test('cost and call counts are summed across every round of every agent loop', () => {
  const store = makeStore();
  const runId = seedRun(store, {
    meta: { stage: 'done', nodeStatus: {} },
    log: [
      { event: 'model_call', node: 'a', ms: 1000, usage: { cost: 0.01 } },
      { event: 'model_call', node: 'a', ms: 2000, usage: { cost: 0.02 } },
      { event: 'model_call', node: 'b', ms: 500, usage: { cost: 0.005 } },
      { event: 'tool_call', node: 'a', tool: 'read_file' }
    ]
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'completed');
  assert.equal(r.signals.modelCalls, 3);
  assert.equal(r.signals.modelMs, 3500);
  assert.equal(r.signals.usd, 0.035);
});

// --- probeModel -----------------------------------------------------------

registerProvider('probe-empty', async () => ({
  text: '', reasoning: 'x'.repeat(4000), finishReason: 'length',
  usage: { completion_tokens_details: { reasoning_tokens: 1024 } }
}));
registerProvider('probe-good', async () => ({
  text: 'A real answer.', reasoning: '', finishReason: 'stop', usage: {}
}));
registerProvider('probe-broken', async () => { throw new Error('OpenRouter API 401: bad key'); });

// The verdict is the product. "It returned nothing" was already known; what was
// missing is whether that is the model, the budget, or the configuration.
test('probeModel tells a starved reasoning model apart from a broken one', async () => {
  const starved = await probeModel({ provider: 'probe-empty', model: 'm' }, { maxTokens: 4096, stream: false });
  assert.equal(starved.ok, false);
  assert.equal(starved.reasons, true);
  assert.match(starved.verdict, /reasoning only at max_tokens 4096/);

  const broken = await probeModel({ provider: 'probe-broken', model: 'm' }, { stream: false });
  assert.equal(broken.ok, false);
  assert.match(broken.verdict, /unreachable/);
  assert.match(broken.error, /401/);

  const good = await probeModel({ provider: 'probe-good', model: 'm' }, { stream: false });
  assert.equal(good.ok, true);
  assert.equal(good.verdict, 'usable');
  assert.equal(good.reasons, false);
});

// --- modelsInFlow ---------------------------------------------------------

// doctor checks the models a flow actually pins, including the ones only a
// fan-out lane names — those are exactly the ones that had never been checked.
test('modelsInFlow finds lane workers, not just node workers', () => {
  const flow = {
    nodes: [
      { id: 'a', data: { worker: { provider: 'auto', model: 'deepseek/x' } } },
      {
        id: 'read',
        data: {
          worker: { provider: 'auto', model: 'deepseek/x' },
          lanes: [{ id: 'l1', worker: { model: 'moonshotai/k' } }, { id: 'l2', worker: { model: 'other/z' } }]
        }
      },
      { id: 'out', data: {} }
    ]
  };
  assert.deepEqual(modelsInFlow(flow).sort(), ['deepseek/x', 'moonshotai/k', 'other/z']);
});

// --- a run parked on a question -------------------------------------------
//
// `flyt why` is the command for "why did this stall". On a run parked at the
// input gate it used to print the stage and the call stats and nothing else —
// telling the person who ran it exactly what they already knew, and not the one
// thing that would unstick it: the question, and that they are the answer.

test('explain names the question, who asked it, and that nothing is running', () => {
  const store = makeStore();
  const runId = store.createRun('an idea worth interrogating');
  store.writeFlow(runId, {
    id: 'f', name: 'F',
    nodes: [{ id: 'ask', type: 'aiStep', data: { role: 'interrogate', title: 'What are we actually building?' } }],
    edges: []
  });
  store.setStage(runId, 'awaiting_input', {
    pendingNodeId: 'ask',
    pendingGateKind: 'input',
    pendingQuestions: [
      { id: 'shape', text: 'Node or flow?', why: 'changes the whole build', options: ['a node', 'a flow'] },
      { id: 'scope', text: 'Who consumes the spec?' }
    ]
  });

  const r = explainRun(store, runId);
  assert.equal(r.verdict, 'waiting for your answer', 'not "still running" — nothing is');
  assert.equal(r.asking.node, 'ask');
  assert.equal(r.asking.title, 'What are we actually building?', 'the title, not the node id');
  assert.deepEqual(r.asking.questions.map(q => q.text), ['Node or flow?', 'Who consumes the spec?']);
  assert.deepEqual(r.asking.questions[0].options, ['a node', 'a flow']);
});

test('a run that is not parked carries no question block', () => {
  const store = makeStore();
  const runId = store.createRun('an ordinary run');
  store.setStage(runId, 'done');
  assert.equal(explainRun(store, runId).asking, undefined);
});
