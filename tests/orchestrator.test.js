// Orchestrator container + output-port tests:
//   - autonomous planning -> children materialized INSIDE the box (parentId,
//     managedBy), run without gates, aggregated into the primary output
//   - dependsOn ordering between children
//   - an invalid plan fails the node honestly (after the bounded re-ask)
//   - edges with sourceHandle receive the source's auxiliary port artifact
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, roleOf, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const CONTRACT = plan => '```json\n' + JSON.stringify(plan) + '\n```';

function orchFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('orch', 'orchestrator', { title: 'Orchestrator' }),
     node('out', 'output')],
    [edge('in', 'orch'), edge('orch', 'out')]);
}

test('orchestrator materializes children inside its box and aggregates their outputs', async () => {
  const store = makeStore();
  const plan = {
    nodes: [
      { id: 'w1', template: 'code-general-step', title: 'Work one', goal: 'Do part 1', category: 'Code general' },
      { id: 'w2', template: 'documentation-step', title: 'Work two', goal: 'Do part 2', category: 'documentation' }
    ],
    parallelGroups: [['w1', 'w2']],
    summary: 'Two parallel work nodes.'
  };
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'orchestrate') return CONTRACT(plan);
    const goal = (prompt.match(/GOAL:\n(.+)/) ?? [])[1] ?? '?';
    return `completed: ${goal}`;
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orchFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  assert.equal(meta.nodeStatus.orch, 'done');
  assert.equal(meta.nodeStatus.w1, 'done');
  assert.equal(meta.nodeStatus.w2, 'done');

  const flow = store.readFlow(runId);
  const w1 = flow.nodes.find(n => n.id === 'w1');
  assert.equal(w1.parentId, 'orch');
  assert.equal(w1.data.managedBy, 'orch');
  assert.equal(w1.data.requiresApproval, false);
  const orch = flow.nodes.find(n => n.id === 'orch');
  assert.ok(orch.data.box?.w > 0 && orch.data.box?.h > 0, 'container box sized to fit children');

  // Children are wired to the container only — never past it.
  assert.ok(flow.edges.some(e => e.source === 'orch' && e.target === 'w1'));
  assert.ok(!flow.edges.some(e => e.source === 'w1' && e.target === 'out'));

  // Aggregated primary output + summary port sidecar.
  const agg = store.readNodeOutput(runId, 'orch');
  assert.match(agg, /Work one \(w1\)/);
  assert.match(agg, /completed: Do part 1/);
  assert.match(agg, /completed: Do part 2/);
  assert.match(store.readNodeOutput(runId, 'orch.summary'), /Two parallel work nodes\./);

  // Downstream (the Output node) sees the orchestrator's aggregate.
  assert.match(store.readNodeOutput(runId, 'out'), /completed: Do part 2/);
});

test('orchestrator honors dependsOn ordering between children', async () => {
  const store = makeStore();
  const order = [];
  const plan = {
    nodes: [
      { id: 'first', template: 'code-general-step', goal: 'step-first' },
      { id: 'second', template: 'code-general-step', goal: 'step-second', dependsOn: ['first'] }
    ],
    summary: 'Sequential.'
  };
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'orchestrate') return CONTRACT(plan);
    order.push((prompt.match(/GOAL:\n(step-\w+)/) ?? [])[1]);
    return 'ok';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orchFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.deepEqual(order, ['step-first', 'step-second']);
});

test('orchestrator fails honestly when the plan stays invalid after the re-ask', async () => {
  const store = makeStore();
  let calls = 0;
  setScript(({ system }) => {
    if (roleOf(system) === 'orchestrate') { calls += 1; return 'no contract here'; }
    return 'ok';
  });
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(orchFlow(), { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'failed');
  assert.equal(meta.nodeStatus.orch, 'failed');
  assert.equal(calls, 2, 'one attempt + one bounded re-ask');
  const retro = store.readRetrospectives(runId).orch;
  assert.equal(retro.status, 'failed');
});

test('an edge with sourceHandle carries the auxiliary port artifact (step-eval verdict)', async () => {
  const store = makeStore();
  let sinkPrompt = null;
  setScript(({ system, prompt }) => {
    const role = roleOf(system);
    if (role === 'execute') return 'the work output';
    if (role === 'step-eval') {
      return 'Long report text.\n```json\n{ "verdict": "pass", "reason": "looks right", "guidance": "" }\n```';
    }
    sinkPrompt = prompt;
    return 'sink done';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'aiStep', { role: 'execute', title: 'Work' }),
     node('eval', 'aiStep', { role: 'step-eval', title: 'Eval' }),
     node('sink', 'aiStep', { role: 'custom', title: 'Sink' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'eval'),
     { id: 'e-eval-sink-verdict', source: 'eval', target: 'sink', sourceHandle: 'verdict' },
     edge('sink', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');

  // The verdict sidecar exists and is exactly what the sink received.
  assert.match(store.readNodeOutput(runId, 'eval.verdict'), /"verdict": "pass"/);
  assert.match(sinkPrompt, /output: verdict/);
  assert.match(sinkPrompt, /"verdict": "pass"/);
  assert.ok(!sinkPrompt.includes('Long report text.'), 'chosen port replaces the full report');
});

test('orchestrator with authored children skips planning and runs exactly them', async () => {
  const store = makeStore();
  let planCalls = 0;
  const ran = [];
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'orchestrate') { planCalls += 1; return CONTRACT({ nodes: [], summary: 'unused' }); }
    ran.push((prompt.match(/GOAL:\n(.+)/) ?? [])[1] ?? '?');
    return 'authored result';
  });
  // Two nodes placed inside the box by hand (parentId, no managedBy): they
  // ARE the plan — no orchestrate call, both run in the sub-walk, outputs
  // aggregated into the orchestrator's primary output.
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('orch', 'orchestrator', { title: 'Orchestrator', box: { w: 522, h: 270 } }),
     { id: 'a', type: 'aiStep', parentId: 'orch', position: { x: 22, y: 58 },
       data: { title: 'Authored A', role: 'execute', goal: 'goal-a' } },
     { id: 'b', type: 'aiStep', parentId: 'orch', position: { x: 272, y: 58 },
       data: { title: 'Authored B', role: 'execute', goal: 'goal-b' } },
     node('out', 'output')],
    [edge('in', 'orch'), edge('orch', 'a'), edge('orch', 'b'), edge('orch', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'done');
  assert.equal(planCalls, 0, 'authored children replace the planning call');
  assert.equal(meta.nodeStatus.orch, 'done');
  assert.equal(meta.nodeStatus.a, 'done');
  assert.equal(meta.nodeStatus.b, 'done');
  assert.deepEqual(ran.sort(), ['goal-a', 'goal-b']);

  const agg = store.readNodeOutput(runId, 'orch');
  assert.match(agg, /Authored A \(a\)/);
  assert.match(agg, /Authored B \(b\)/);
  // The summary sidecar lists the authored inventory.
  assert.match(store.readNodeOutput(runId, 'orch.summary'), /2 authored node\(s\)/);
});

test('authored children are never scheduled by the outer walk', async () => {
  const store = makeStore();
  const ran = [];
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'orchestrate') return CONTRACT({ nodes: [], summary: 'unused' });
    ran.push((prompt.match(/GOAL:\n(.+)/) ?? [])[1] ?? '?');
    return 'ok';
  });
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('orch', 'orchestrator', { title: 'Orchestrator' }),
     { id: 'kid', type: 'aiStep', parentId: 'orch', position: { x: 22, y: 58 },
       data: { title: 'Kid', role: 'execute', goal: 'kid-goal' } },
     node('out', 'output')],
    [edge('in', 'orch'), edge('orch', 'kid'), edge('orch', 'out')]);
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(flow, { userInput: 'brief' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(store.readMeta(runId).stage, 'done');
  // Exactly once: the sub-walk ran it, the outer scheduler did not.
  assert.deepEqual(ran, ['kid-goal']);
});
