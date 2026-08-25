// The pre-node approval checkpoint must honour approvalMode the way the other
// readers of it already do. The documented contract sits on the tool gate
// (core/flowRunner.js, runPendingTasks/isGated): DESIGN-SPEC.md §5 — 'always'
// IS "the agent runs unattended", so 'always' means nothing is gated, whatever
// the node says. isGated() returned false under 'always' and the question
// gates answered their own questions under it, but gate() read only the node
// flag — so an unattended run could conclude repeatedly that no human was
// answering its questions and then park forever at a requiresApproval node,
// waiting for the human it had just established was absent.
//
// The fix is narrowing-only: 'always' passes the checkpoint and logs it;
// 'ask' and 'smart' pause exactly as before; no mode's meaning changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner } from '../core/flowRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const gatedFlow = () => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
   node('out', 'output')],
  [edge('in', 'step'), edge('step', 'out')]);

test("approvalMode 'always': a requiresApproval node never parks — the checkpoint is passed and logged", async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new FlowRunner(store, testConfig());
  // Started unattended: nothing in this test ever answers a gate.
  const runId = runner.start(gatedFlow(), { approvalMode: 'always' });

  const stage = await waitForStage(store, runId, ['done', 'failed']);
  assert.equal(stage, 'done');
  assert.equal(store.readMeta(runId).stage, 'done');
  assert.equal(store.readMeta(runId).pendingGateKind ?? null, null,
    'the run did not stop on the pre-node checkpoint');
  assert.equal(store.readMeta(runId).nodeStatus.step, 'done');
  assert.match(store.readNodeOutput(runId, 'step'), /step output/,
    'the gated node ran, not merely was bypassed');

  // The pass through the checkpoint is recorded, not silent.
  const skipped = store.readLog(runId).filter(e => e.event === 'approval_gate_skipped');
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].node, 'step');
  assert.match(skipped[0].reason, /unattended/);

  // No human decision was fabricated: the gate was passed, not self-approved.
  assert.ok(!store.readLog(runId).some(e => e.event === 'human_decision'),
    'an unattended pass is a skip, not a fake approval');
});

test("approvalMode 'ask': a requiresApproval node still pauses for a human, then approves through", async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(gatedFlow(), { approvalMode: 'ask' });

  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'failed']), 'awaiting_approval');
  assert.equal(store.readMeta(runId).pendingGateKind, 'pre');
  assert.equal(store.readMeta(runId).pendingNodeId, 'step');

  runner.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.ok(store.readLog(runId).some(e =>
    e.event === 'human_decision' && e.decision === 'approved'));
  assert.equal(store.readLog(runId).filter(e => e.event === 'approval_gate_skipped').length, 0,
    'an attended run does not log skips');
});

test("approvalMode 'smart': a requiresApproval node still pauses for a human", async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new FlowRunner(store, testConfig());
  const runId = runner.start(gatedFlow(), { approvalMode: 'smart' });

  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'failed']), 'awaiting_approval');
  assert.equal(store.readMeta(runId).pendingGateKind, 'pre');

  runner.approvePlan(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
});

test('without a node flag the pre-node gate stays inert in every mode', async () => {
  const flow = () => makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('step', 'aiStep', { role: 'execute' }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);
  for (const approvalMode of ['always', 'ask']) {
    const store = makeStore();
    setScript(() => 'step output');
    const runner = new FlowRunner(store, testConfig());
    const runId = runner.start(flow(), { approvalMode });
    assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done',
      `ungated node at ${approvalMode}`);
    assert.equal(store.readLog(runId).filter(e => e.event === 'approval_gate_skipped').length, 0,
      `nothing to skip at ${approvalMode}`);
  }
});
