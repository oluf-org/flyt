// Integration + unit tests for the flow graph runner (core/flowRunner.js):
// topology, worker resolution, plan-eval materialization (incl. the bounded
// re-ask), the step-eval retry loop, and approval-gate persistence across a
// simulated app restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FlowRunner, topoSort, resolveWorker } from '../core/flowRunner.js';
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
  const runner = new FlowRunner(store, config);
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, config);
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig({ maxParallel: 2 }));
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner = new FlowRunner(store, testConfig());
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
  const runner1 = new FlowRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner1.start(flow);
  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'failed']), 'awaiting_approval');
  assert.equal(store.readMeta(runId).pendingGateKind, 'pre');

  // "Restart": a fresh runner with empty in-memory gates, same file state.
  const runner2 = new FlowRunner(store, config);
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
  const runner1 = new FlowRunner(store, config);
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner1.start(flow);
  await waitForStage(store, runId, ['awaiting_approval']);

  const runner2 = new FlowRunner(store, config);
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
  const runner1 = new FlowRunner(store, config);
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

  const runner2 = new FlowRunner(store, config);
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
test('an aiStep whose model returns an empty response fails instead of succeeding', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  setScript(() => '   \n  ');
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('step', 'aiStep', { role: 'execute' }), node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.equal(store.readMeta(runId).nodeStatus.step, 'failed');
  assert.match(store.readMeta(runId).error, /empty response/);
  assert.equal(store.readRetrospectives(runId).step.status, 'failed');
});

test('an agentTask whose agent returns an empty response fails instead of succeeding', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
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
