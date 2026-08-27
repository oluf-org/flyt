// Integration + unit tests for the flow graph runner (core/stackRunner.js):
// topology, worker resolution, plan-eval materialization (incl. the bounded
// re-ask), the step-eval retry loop, and approval-gate persistence across a
// simulated app restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { StackRunner, topoSort, resolveWorker } from '../core/stackRunner.js';
import { Ledger } from '../core/ledger.js';
import os from 'node:os';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const readLog = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));

// --- topoSort ---

test('topoSort orders nodes by dependencies', () => {
  const flow = makeFlow(
    [node('c', 'output'), node('a', 'input'), node('b', 'aiStep')],
    [edge('a', 'b'), edge('b', 'c')]);
  assert.deepEqual(topoSort(flow).map(n => n.id), ['a', 'b', 'c']);
});

test('topoSort throws on cycles', () => {
  const flow = makeFlow(
    [node('a', 'aiStep'), node('b', 'aiStep')],
    [edge('a', 'b'), edge('b', 'a')]);
  assert.throws(() => topoSort(flow), /cycle/);
});

// --- resolveWorker ---

test('resolveWorker: explicit node worker wins over category and default', () => {
  const config = testConfig({ categoryWorkers: { documentation: { provider: 'cat', model: 'cat-m' } } });
  const n = node('x', 'aiStep', { category: 'documentation', worker: { provider: 'exp', model: 'exp-m' } });
  assert.deepEqual(resolveWorker(n, config), { provider: 'exp', model: 'exp-m' });
});

test('resolveWorker: category worker beats the executor default', () => {
  const config = testConfig({ categoryWorkers: { documentation: { provider: 'cat', model: 'cat-m' } } });
  assert.deepEqual(resolveWorker(node('x', 'aiStep', { category: 'documentation' }), config),
    { provider: 'cat', model: 'cat-m' });
});

test('resolveWorker: a run-level worker routes unpinned nodes, and carries no key', () => {
  // A level or a pinned model (DESIGN-SPEC.md §8) becomes every unpinned node's
  // worker. It must arrive as provider/model/routing and nothing else: this
  // object is logged verbatim in `node_start`, so spreading a stamped worker
  // wrote a live OpenRouter key into every run's log.jsonl — a file agents
  // read, the archive copies, and people paste into bug reports. The key is
  // looked up at call time from providerKeys, so nothing needs it here.
  const config = testConfig({
    levelWorker: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro', apiKey: 'sk-or-v1-secret' }
  });
  const w = resolveWorker(node('x', 'aiStep', {}), config);
  assert.deepEqual(w, { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro' });
  assert.ok(!('apiKey' in w));
  assert.ok(!JSON.stringify(w).includes('secret'));

  // A band still travels: it is how the Auto Router is asked for a cost tier.
  const banded = testConfig({ levelWorker: { provider: 'openrouter', model: 'openrouter/auto', routing: { costTier: 'high' } } });
  assert.deepEqual(resolveWorker(node('x', 'aiStep', {}), banded).routing, { costTier: 'high' });

  // ...and a node that names its own model still wins over both.
  assert.deepEqual(
    resolveWorker(node('x', 'aiStep', { worker: { provider: 'exp', model: 'exp-m' } }), config),
    { provider: 'exp', model: 'exp-m' });
});

test('resolveWorker: falls back to the executor default', () => {
  assert.deepEqual(resolveWorker(node('x', 'aiStep', {}), testConfig()),
    { provider: 'script', model: 'test-model' });
});

// The BYO-key trap (V1 task 11). categoryWorkers is read from config.json and
// is NOT overridable from Settings, so anything it names is pinned for good.
// It shipped mapping every category to the mock provider, which meant a user
// who saved a real key and pointed the executor at a real model still had every
// categorised work node — including test-creation-step, the only tool-using
// agentTask template — silently answer with "(mock output)". Shipping it empty
// is what makes one Settings change reach the whole app.
test('resolveWorker: an unmapped category follows the executor, so a real key reaches work nodes', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.json'), 'utf8'));
  assert.deepEqual(shipped.categoryWorkers, {},
    'config.json must not pin categories to a provider: Settings cannot override them');

  const userConfig = { ...shipped, workers: { executor: { provider: 'openrouter', model: 'real/model' } } };
  for (const category of ['Code design', 'Code general', 'documentation', 'Test-creation']) {
    assert.deepEqual(resolveWorker(node('x', 'agentTask', { category }), userConfig),
      { provider: 'openrouter', model: 'real/model' }, `category "${category}" must follow the executor`);
  }
});

// The mechanism itself stays (V1 keeps static category routing) — an explicit
// mapping still wins for anyone who hand-edits config.json.
test('resolveWorker: an explicitly mapped category still overrides the executor', () => {
  const config = testConfig({ categoryWorkers: { documentation: { provider: 'x', model: 'cheap' } } });
  assert.deepEqual(resolveWorker(node('d', 'aiStep', { category: 'documentation' }), config),
    { provider: 'x', model: 'cheap' });
  assert.deepEqual(resolveWorker(node('c', 'aiStep', { category: 'Code general' }), config),
    { provider: 'script', model: 'test-model' });
});

test('agentTask nodes get their category worker (unified resolution)', async () => {
  const store = makeStore();
  const config = testConfig({ categoryWorkers: { 'Test-creation': { provider: 'script', model: 'cat-model' } } });
  setScript(() => 'Task complete.');
  const runner = new StackRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('at', 'agentTask', { title: 'Make tests', goal: 'Write tests.', category: 'Test-creation' }),
     node('out', 'output')],
    [edge('in', 'at'), edge('at', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const task = store.readTasks(runId).tasks[0];
  assert.deepEqual(task.worker, { provider: 'script', model: 'cat-model' });
});

// --- plan-eval materialization ---

const planEvalDoc = nodes => '```json\n' + JSON.stringify({ nodes }, null, 2) + '\n```';

test('materializeGeneratedNodes rejects dependency cycles among generated nodes', () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  const runId = store.createRun('brief');
  const pe = node('pe', 'aiStep', { role: 'plan-eval' });
  const flow = makeFlow([pe, node('out', 'output')], [edge('pe', 'out')]);
  const r = runner.materializeGeneratedNodes(runId, flow, pe, planEvalDoc([
    { id: 'a', template: 'code-general-step', goal: 'A', dependsOn: ['b'] },
    { id: 'b', template: 'code-general-step', goal: 'B', dependsOn: ['a'] }
  ]));
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /cycle/);
  assert.equal(flow.nodes.length, 2); // nothing was added
  assert.match(store.readNodeOutput(runId, 'plan-eval-errors'), /cycle/);
});

test('materializeGeneratedNodes skips specs whose id already exists in the flow', () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  const runId = store.createRun('brief');
  const pe = node('pe', 'aiStep', { role: 'plan-eval' });
  const flow = makeFlow([pe, node('out', 'output')], [edge('pe', 'out')]);
  const r = runner.materializeGeneratedNodes(runId, flow, pe, planEvalDoc([
    { id: 'pe', template: 'code-general-step', goal: 'clashes with the plan-eval node itself' },
    { id: 'gen-x', template: 'code-general-step', goal: 'fine' }
  ]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.created.map(n => n.id), ['gen-x']);
  // Wiring: root hangs off plan-eval, leaf feeds plan-eval's downstream target.
  const edges = flow.edges.filter(e => e.generatedBy === 'pe');
  assert.ok(edges.some(e => e.source === 'pe' && e.target === 'gen-x'));
  assert.ok(edges.some(e => e.source === 'gen-x' && e.target === 'out'));
});

test('smoke: full advanced-planning flow runs to done on the mock provider', async () => {
  const store = makeStore();
  const config = testConfig({
    workers: { executor: { provider: 'mock', model: 'mock-large' } }
  });
  const runner = new StackRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'Build a config loader' }),
     node('ps', 'aiStep', { role: 'plan-start', title: 'Start' }),
     node('pe', 'aiStep', { role: 'plan-eval', title: 'Plan Eval' }),
     node('out', 'output')],
    [edge('in', 'ps'), edge('ps', 'pe'), edge('pe', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed'], { timeoutMs: 60000 }), 'done');

  // The mock plan-eval declares gen-design -> gen-impl -> gen-docs.
  const ranFlow = store.readFlow(runId);
  for (const id of ['gen-design', 'gen-impl', 'gen-docs']) {
    assert.ok(ranFlow.nodes.some(n => n.id === id), `missing materialized node ${id}`);
    assert.ok(store.readNodeOutput(runId, id), `missing output for ${id}`);
  }
  const statuses = store.readMeta(runId).nodeStatus;
  for (const [id, s] of Object.entries(statuses)) assert.equal(s, 'done', `node ${id} is ${s}`);
  assert.ok(fs.existsSync(path.join(store.runDir(runId), 'result.md')));
  assert.ok(readLog(store, runId).some(e => e.event === 'materialized_nodes'));
});

test('plan-eval re-asks once with the validation errors on malformed output', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  let peCalls = 0;
  let sawErrorsInReask = false;
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'plan-eval') {
      peCalls += 1;
      if (peCalls === 1) return 'Here is my plan, in prose only. No JSON today.';
      sawErrorsInReask = prompt.includes('VALIDATION ERRORS');
      return planEvalDoc([{ id: 'gen-a', template: 'documentation-step', title: 'Docs', goal: 'Write the docs.' }]);
    }
    return 'step output';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('pe', 'aiStep', { role: 'plan-eval' }),
     node('out', 'output')],
    [edge('in', 'pe'), edge('pe', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(peCalls, 2);
  assert.ok(sawErrorsInReask, 're-ask prompt should include the validation errors');
  assert.ok(store.readFlow(runId).nodes.some(n => n.id === 'gen-a'));
  assert.equal(store.readMeta(runId).nodeStatus['gen-a'], 'done');
  assert.ok(readLog(store, runId).some(e => e.event === 'structured_output_reask'));
  assert.match(store.readNodeOutput(runId, 'plan-eval-errors'), /resolved/);
});

// --- parallel waves ---

test('independent aiSteps run concurrently as one wave', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  let inFlight = 0;
  let maxInFlight = 0;
  setScript(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 120));
    inFlight -= 1;
    return 'step output';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('a', 'aiStep', { role: 'execute', title: 'A' }),
     node('b', 'aiStep', { role: 'execute', title: 'B' }),
     node('c', 'aiStep', { role: 'execute', title: 'C' }),
     node('out', 'output')],
    [edge('in', 'a'), edge('in', 'b'), edge('in', 'c'),
     edge('a', 'out'), edge('b', 'out'), edge('c', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(maxInFlight, 3, 'all three independent steps should be in flight together');
  assert.ok(readLog(store, runId).some(e => e.event === 'wave_start' && e.nodes.length === 3));
  for (const id of ['a', 'b', 'c']) assert.match(store.readNodeOutput(runId, id), /step output/);
});

test('maxParallel caps the wave size', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig({ maxParallel: 2 }));
  let inFlight = 0;
  let maxInFlight = 0;
  setScript(async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(r => setTimeout(r, 60));
    inFlight -= 1;
    return 'step output';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('a', 'aiStep', {}), node('b', 'aiStep', {}), node('c', 'aiStep', {}),
     node('out', 'output')],
    [edge('in', 'a'), edge('in', 'b'), edge('in', 'c'),
     edge('a', 'out'), edge('b', 'out'), edge('c', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.ok(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
});

test('a failure inside a wave fails the run', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(async ({ prompt }) => {
    if (prompt.includes('GOAL:\nboom')) throw new Error('provider exploded');
    return 'ok';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('a', 'aiStep', { title: 'A' }),
     node('b', 'aiStep', { title: 'B', goal: 'boom' }),
     node('out', 'output')],
    [edge('in', 'a'), edge('in', 'b'), edge('a', 'out'), edge('b', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.b, 'failed');
});

// --- incremental output (adapter onText streaming) ---

test('aiStep streams partial output into the node file while the call runs', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(async ({ onText }) => {
    onText('partial text so far');
    await new Promise(r => setTimeout(r, 400));
    return 'final full text';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute' }),
     node('out', 'output')],
    [edge('in', 'step'), edge('in', 'out'), edge('step', 'out')]);
  const runId = runner.start(flow);
  const partial = await waitFor(() => store.readNodeOutput(runId, 'step'), { label: 'partial node output' });
  assert.match(partial, /partial text so far/);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(store.readNodeOutput(runId, 'step'), 'final full text');
});

// The path that matters most for V1: an agentTask is the long, tool-using one,
// and it was the silent one — runAgent never forwarded onText.
test('agentTask streams the agent turn into the task output while the call runs', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(async ({ onText }) => {
    onText('partial agent reply');
    await new Promise(r => setTimeout(r, 400));
    return 'final agent deliverable';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'agentTask', { title: 'Worker', goal: 'do the work' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);
  const runId = runner.start(flow);
  const partial = await waitFor(() => store.readTaskOutput(runId, 'task-1'), { label: 'partial task output' });
  assert.match(partial, /partial agent reply/);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(store.readTaskOutput(runId, 'task-1'), 'final agent deliverable');
});

// The multi-turn contract: onText streams the turn IN PROGRESS, so a turn that
// ends in a tool call is visible (that transparency is the point — you watch
// the agent decide), and the executor's write after the loop is what lands.
test('a tool-calling turn streams, then the final reply supersedes it', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  const turn1 = 'Recording the spec first.\n```tool\n{"tool":"write_task_md","args":{"content":"# Spec"}}\n```';
  setScript(async ({ prompt, onText }) => {
    if (prompt.includes('TOOL RESULT')) return 'final deliverable';
    onText(turn1);
    await new Promise(r => setTimeout(r, 400));
    return turn1;
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'agentTask', { title: 'Worker', goal: 'do the work' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);
  const runId = runner.start(flow);
  const mid = await waitFor(() => {
    const t = store.readTaskOutput(runId, 'task-1');
    return t?.includes('write_task_md') ? t : null;
  }, { label: 'the streamed tool block' });
  assert.match(mid, /Recording the spec first/);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  // No tool block left behind: the last turn's real deliverable replaced it.
  assert.equal(store.readTaskOutput(runId, 'task-1'), 'final deliverable');
});

// --- step-eval retry loop ---

test('step-eval retry re-runs the work node with persisted guidance, then passes', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  let workCalls = 0;
  let evalCalls = 0;
  setScript(({ system }) => {
    const role = roleOf(system);
    if (role === 'step-eval') {
      evalCalls += 1;
      return evalCalls === 1
        ? '```json\n{ "verdict": "retry", "reason": "too vague", "guidance": "be concrete" }\n```'
        : '```json\n{ "verdict": "pass", "reason": "fixed" }\n```';
    }
    workCalls += 1;
    return `work attempt ${workCalls}`;
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'aiStep', { role: 'execute', title: 'Work' }),
     node('seval', 'aiStep', { role: 'step-eval', maxRetries: 1 }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'seval'), edge('seval', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(workCalls, 2, 'work node should run twice');
  assert.equal(evalCalls, 2, 'step-eval should re-evaluate the fresh output');
  assert.match(store.readNodeOutput(runId, 'retry-for-work'), /be concrete/);
  assert.match(store.readNodeOutput(runId, 'work'), /attempt 2/);
  assert.ok(readLog(store, runId).some(e => e.event === 'step_eval_retry'));
});

// --- approval-gate persistence across a simulated restart ---

test('pre-node approval gate survives a restart: approve resumes to done', async () => {
  const store = makeStore();
  const config = testConfig();
  setScript(() => 'step output');
  const runner1 = new StackRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner1.start(flow);
  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'failed']), 'awaiting_approval');
  assert.equal(store.readMeta(runId).pendingGateKind, 'pre');

  // "Restart": a fresh runner with empty in-memory gates, same file state.
  const runner2 = new StackRunner(store, config);
  runner2.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.match(store.readNodeOutput(runId, 'step'), /step output/);
  assert.ok(readLog(store, runId).some(e =>
    e.event === 'human_decision' && e.decision === 'approved' && /resumed after restart/.test(e.context ?? '')));
});

test('pre-node approval gate survives a restart: reject marks the run rejected', async () => {
  const store = makeStore();
  const config = testConfig();
  setScript(() => 'step output');
  const runner1 = new StackRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner1.start(flow);
  await waitForStage(store, runId, ['awaiting_approval']);

  const runner2 = new StackRunner(store, config);
  runner2.rejectPlan(runId, 'not like this');
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'rejected');
  assert.equal(meta.nodeStatus.step, 'pending');
});

test('step-eval escalation gate survives a restart: approve resumes to done', async () => {
  const store = makeStore();
  const config = testConfig();
  setScript(({ system }) =>
    roleOf(system) === 'step-eval'
      ? '```json\n{ "verdict": "escalate", "reason": "human should look at this" }\n```'
      : 'work output');
  const runner1 = new StackRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'aiStep', { role: 'execute' }),
     node('seval', 'aiStep', { role: 'step-eval' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'seval'), edge('seval', 'out')]);
  const runId = runner1.start(flow);
  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'failed']), 'awaiting_approval');
  assert.equal(store.readMeta(runId).pendingGateKind, 'escalation');
  assert.equal(store.readMeta(runId).pendingNodeId, 'seval');

  const runner2 = new StackRunner(store, config);
  runner2.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const statuses = store.readMeta(runId).nodeStatus;
  assert.equal(statuses.seval, 'done');
  assert.equal(statuses.out, 'done');
  assert.ok(readLog(store, runId).some(e => e.event === 'flow_run_resumed'));
});

// A node whose model returns nothing must fail loudly. It used to be recorded
// as success with a 0-byte output file, which then became the context every
// downstream node read (V1 task 11 — seen on a real provider).
//
// It must also fail INFORMATIVELY (D40). The message used to be "<model>
// returned an empty response" and nothing else, which named the one fact the
// reader already had and none of the ones that pick the fix — three separate
// live runs died on it with no way forward but to run them again.
test('an aiStep whose model returns an empty response fails instead of succeeding', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(() => '   \n  ');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('step', 'aiStep', { role: 'execute' }), node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.step, 'failed');
  const error = store.readMeta(runId).error;
  assert.match(error, /returned no content/);
  // The nudged retry ran and is reported, so the reader knows this was not a
  // one-off flake before they go looking.
  assert.match(error, /retry at max_tokens \d+ also came back empty/);
  assert.equal(store.readRetrospectives(runId).step.status, 'failed');
  // The empty turn is on the record with its diagnosis, not just in the message.
  const empty = readLog(store, runId).filter(e => e.event === 'model_empty_turn');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].node, 'step');
  assert.ok(empty[0].retriedWith > empty[0].maxTokens, 'the recovery attempt must raise the budget');
});

test('an aiStep whose output is truncated preserves the partial but fails before downstream work', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(() => ({ text: '# Report\n\n## Cut off', finishReason: 'length', usage: null }));
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('step', 'aiStep', { role: 'execute' }), node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow);

  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.step, 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.out, 'pending');
  assert.equal(store.readNodeOutput(runId, 'step'), '# Report\n\n## Cut off');
  assert.match(store.readMeta(runId).error, /finish_reason "length"/);
  assert.ok(readLog(store, runId).some(e => e.event === 'output_truncated' && e.node === 'step'));
});

test('an agentTask whose agent returns an empty response fails instead of succeeding', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(() => '');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'agentTask', { title: 'W', goal: 'do it' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readTasks(runId).tasks[0].status, 'failed');
});

// node_start must record which tool protocol the executor used, so a real run
// is auditable after the fact rather than inferred (V1 task 11).
test('the executor logs which tool protocol it used', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(() => 'done');
  const flow = makeFlow(
    [node('in', 'input', { text: 'b' }),
     node('w', 'agentTask', { title: 'W', goal: 'g' }),
     node('out', 'output')],
    [edge('in', 'w'), edge('w', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  const start = readLog(store, runId).find(e => e.event === 'node_start' && e.node === 'executor:task-1');
  // The 'script' test provider isn't openrouter, so it takes the text path.
  assert.equal(start.protocol, 'text');
});

// streamInto throttles on the reasoning that the caller's write afterwards is
// authoritative — true for one call, false inside an agent loop, where a turn is
// superseded by the NEXT turn. So the last emit of a call must never be dropped:
// a tool call's name arrives first and takes the flush window, and its arguments
// stream in behind it (V1 task 12).
test('streamInto never throttles away the final emit of a call', () => {
  const store = makeStore();
  const runId = store.createRun('b');
  const runner = new StackRunner(store, testConfig());
  const written = [];
  const sink = runner.streamInto(runId, t => written.push(t));

  sink('→ write_file(');                       // first: flushes
  sink('→ write_file({"path":"a.js"');         // within 250ms: dropped
  sink('→ write_file({"path":"a.js"})', { final: true }); // must land regardless

  assert.deepEqual(written, ['→ write_file(', '→ write_file({"path":"a.js"})']);
});

test('streamInto still throttles the noisy middle of a stream', () => {
  const store = makeStore();
  const runId = store.createRun('b');
  const runner = new StackRunner(store, testConfig());
  const written = [];
  const sink = runner.streamInto(runId, t => written.push(t));
  for (let i = 0; i < 50; i++) sink('chunk ' + i);
  assert.equal(written.length, 1, '50 rapid chunks must not become 50 writes + 50 IPC pushes');
});

// --- per-edge context sizing (flare 3: edge weight) ---

test('the runner records per-edge context bytes into meta (thick full-context, thin contextSpec)', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  setScript(() => 'a step output long enough to carry weight downstream');
  const flow = makeFlow(
    [node('in', 'input', { text: 'the brief for the run' }),
     node('a', 'aiStep', { role: 'execute', title: 'A' }),
     // b ignores its upstream output and pulls only its declared file:
     node('b', 'aiStep', { role: 'execute', title: 'B',
       contextSpec: { files: [{ path: 'prompt', description: 'the brief' }] } }),
     node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const ec = store.readMeta(runId).edgeContext;
  assert.ok(ec, 'edgeContext should be persisted to meta');
  // A full-context node's incoming edge carried the upstream text (> 0).
  assert.ok(ec['e-in-a'] > 0, `e-in-a should carry context, got ${ec['e-in-a']}`);
  // The contextSpec node ignored its upstream output — that edge carried nothing.
  assert.equal(ec['e-a-b'], 0, 'the edge into a contextSpec node should be measured empty');
});

test('a flow run that nobody supervised still reaches the ledger', async () => {
  // Only the supervisor recorded spend, and only for the runs it started. So
  // every run a person or a flow launched — including the fan-out that reads
  // another repository across four lanes, the most expensive single thing this
  // app does — spent real money and left no ledger line. `flyt spend` answered
  // $3.62 for a day that had emptied an OpenRouter key's total limit, and the
  // caps, which are rolling totals of real money, were counting a fraction.
  const store = makeStore();
  const recorded = [];
  setScript(() => 'done');
  const runner = new StackRunner(store, testConfig());
  runner.ledger = { recordRun: (_store, args) => recorded.push(args) };

  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }), node('work', 'aiStep', { goal: 'do it' }), node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);

  const runId = runner.start(flow, { userInput: 'go' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.deepEqual(recorded, [{ runId }], 'the run it never owned is still counted');

  // A run the supervisor DOES own is left alone: it records the same calls
  // against the TASK when the task ends, and counting them twice would make
  // every cap read double.
  const owned = runner.start(flow, { userInput: 'go', loopTaskId: 't-0001' });
  assert.equal(await waitForStage(store, owned, ['done', 'failed']), 'done');
  assert.equal(recorded.filter(r => r.runId === owned).length, 0);
});
