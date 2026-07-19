// Pre-run gate: FlowRunner.start refuses structurally invalid flows
// (RUNTIME_RULES) but keeps accepting the partial flows tests always used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

test('gate: refuses a flow with a cycle', () => {
  const runner = new FlowRunner(makeStore(), testConfig());
  const flow = makeFlow(
    [node('a', 'aiStep'), node('b', 'aiStep')],
    [edge('a', 'b'), edge('b', 'a')]);
  assert.throws(() => runner.start(flow), /failed validation[\s\S]*cycle/);
});

test('gate: refuses an edge to an undeclared node', () => {
  const runner = new FlowRunner(makeStore(), testConfig());
  const flow = makeFlow([node('a', 'input'), node('b', 'output')],
    [edge('a', 'b'), edge('a', 'ghost')]);
  assert.throws(() => runner.start(flow), /unknown-node/);
});

test('gate: refuses an unknown tool grant', () => {
  const runner = new FlowRunner(makeStore(), testConfig());
  const flow = makeFlow(
    [node('a', 'input'), node('t', 'agentTask', { tools: ['rm_rf'] }), node('b', 'output')],
    [edge('a', 't'), edge('t', 'b')]);
  assert.throws(() => runner.start(flow), /unknown-tool/);
});

test('gate: a valid flow still starts and completes', async () => {
  const store = makeStore();
  setScript(() => 'ok');
  const runner = new FlowRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }), node('s', 'aiStep', { role: 'custom', worker: { provider: 'script', model: 'm' } }), node('out', 'output')],
    [edge('in', 's'), edge('s', 'out')]);
  const runId = runner.start(flow);
  const stage = await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(stage, 'done');
});
