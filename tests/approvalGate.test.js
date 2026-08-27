// The pre-node approval checkpoint must honour approvalMode the way the other
// readers of it already do. The documented contract sits on the tool gate
// (core/stackRunner.js, runPendingTasks/isGated): DESIGN-SPEC.md §5 — 'always'
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
import { StackRunner } from '../core/stackRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge, roleOf } from './helpers.js';

const gatedFlow = () => makeFlow(
  [node('in', 'input', { text: 'brief' }),
   node('step', 'aiStep', { role: 'execute', requiresApproval: true }),
   node('out', 'output')],
  [edge('in', 'step'), edge('step', 'out')]);

test("approvalMode 'always': a requiresApproval node never parks — the checkpoint is passed and logged", async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new StackRunner(store, testConfig());
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
  const runner = new StackRunner(store, testConfig());
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
  const runner = new StackRunner(store, testConfig());
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
    const runner = new StackRunner(store, testConfig());
    const runId = runner.start(flow(), { approvalMode });
    assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done',
      `ungated node at ${approvalMode}`);
    assert.equal(store.readLog(runId).filter(e => e.event === 'approval_gate_skipped').length, 0,
      `nothing to skip at ${approvalMode}`);
  }
});

test("approvalMode 'always': an ESCALATION gate still parks — that one is not ours to pass", async () => {
  // The boundary this change must not cross, and the one nothing else asserts.
  //
  // A pre-node checkpoint under 'always' is a checkpoint the person chose to
  // run past. An ESCALATION gate is different in kind: something looked at the
  // work and concluded a human has to decide. Passing that automatically is not
  // honouring the mode, it is answering the question the run just asked — and
  // the loop already relies on it parking, so it takes the next task instead.
  //
  // The check lives in gate(), which handles the pre-node checkpoint only.
  // Moving it up into resolveGate() or setStage() would "simplify" this into
  // silently self-approving every human-decision gate, and every other test
  // here would still pass.
  const store = makeStore();
  setScript(({ system }) =>
    roleOf(system) === 'step-eval'
      ? '```json\n{ "verdict": "escalate", "reason": "a human should look at this" }\n```'
      : 'work output');
  const runner = new StackRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
     node('work', 'aiStep', { role: 'execute' }),
     node('seval', 'aiStep', { role: 'step-eval' }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'seval'), edge('seval', 'out')]);

  const runId = runner.start(flow, { approvalMode: 'always' });

  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'done', 'failed']),
    'awaiting_approval', 'unattended does not mean unaccountable');
  assert.equal(store.readMeta(runId).pendingGateKind, 'escalation');
  assert.equal(store.readLog(runId).filter(e => e.event === 'approval_gate_skipped').length, 0,
    'and nothing passed a gate it was never given');
});

test('an approvalMode nothing recognises gates, rather than assuming nobody is there', async () => {
  // Fail-closed is the house rule. A mode that is missing, misspelt or from a
  // newer version must never read as "run unattended".
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(gatedFlow(), { approvalMode: 'alway' });

  assert.equal(await waitForStage(store, runId, ['awaiting_approval', 'done', 'failed']),
    'awaiting_approval', 'an unrecognised mode is not permission');
  assert.equal(store.readMeta(runId).pendingGateKind, 'pre');
});
