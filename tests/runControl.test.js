// RUN-CONTROL: stop / pause / restartNode / branch / investigateNode — the
// execution-core half of the run-control IPC contract (electron/main.js is a
// thin pass-through to these StackRunner methods).
//
// Covers: abort threading through callModel (no retry after abort, abort-aware
// backoff), stop() semantics against both a synthetic hanging call and the
// real mock adapter, stop during an approval gate and during a pause hold,
// soft pause between waves, restartNode's downstream reset, and branch
// pruning. Same harness as the other runner tests (tests/helpers.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { StackRunner, downstreamSet, upstreamSet } from '../core/stackRunner.js';
import { callModel } from '../core/adapters/index.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const goalOf = prompt => (prompt.match(/GOAL:\n(.+)/) ?? [])[1]?.trim();

// A model call that hangs until its AbortSignal fires, then rejects the way
// fetch does on abort (name 'AbortError').
const untilAborted = signal => new Promise((_, reject) => {
  const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  if (signal?.aborted) return fail();
  signal?.addEventListener('abort', fail, { once: true });
});

const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));

// in -> a -> b -> out, all aiSteps named by goal.
function linearFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]);
}

// --- abort threading through callModel ---

test('callModel aborts an in-flight call and never retries an abort', async () => {
  let attempts = 0;
  setScript(({ signal }) => { attempts += 1; return untilAborted(signal); });
  const ctl = new AbortController();
  const p = callModel({
    provider: 'script', model: 'm', system: 's', prompt: 'p',
    signal: ctl.signal, retry: { attempts: 5, baseMs: 1 }
  });
  await settle(20);
  ctl.abort();
  await assert.rejects(p, err => err?.name === 'AbortError');
  assert.equal(attempts, 1, 'an aborted call must not be retried');
});

test('callModel aborts while backing off between retries', async () => {
  let attempts = 0;
  setScript(() => { attempts += 1; throw new Error('API 429: rate limited'); });
  const ctl = new AbortController();
  const started = Date.now();
  const p = callModel({
    provider: 'script', model: 'm', system: 's', prompt: 'p',
    signal: ctl.signal, retry: { attempts: 5, baseMs: 60000 }
  });
  await settle(30);
  ctl.abort();
  await assert.rejects(p, err => err?.name === 'AbortError');
  assert.equal(attempts, 1, 'the backoff sleep must not run a second attempt after abort');
  assert.ok(Date.now() - started < 5000, 'the backoff sleep must be abort-aware, not run to completion');
});

// --- stop() ---

test('stop aborts the in-flight call, cancels the run, and frees the live registry', async () => {
  const store = makeStore();
  setScript(({ prompt, signal }) =>
    goalOf(prompt) === 'B' ? untilAborted(signal) : Promise.resolve(`output ${goalOf(prompt)}`));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(linearFlow());
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });

  assert.deepEqual(runner.stop(runId), { ok: true });
  assert.equal(runner.live.has(runId), false, 'stop frees the live registry (run:delete unblocks)');
  // A second stop is refused, and now says WHY rather than 'not-live': the run
  // ended, which is a different fact from 'not in this process' and the one the
  // reader needs. Both carry a message the CLI prints, so these check the
  // fields that are the contract rather than the exact object shape.
  const again = runner.stop(runId);
  assert.equal(again.ok, false, 'a stopped run is no longer live');
  assert.equal(again.error, 'already-ended');
  const paused = runner.pause(runId);
  assert.equal(paused.ok, false);
  assert.equal(paused.error, 'not-live');

  await settle(); // let the unwind flush through fail()
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
  assert.ok(meta.cancelledAt, 'cancelledAt is recorded');
  assert.equal(meta.nodeStatus.a, 'done', 'finished work is kept');
  assert.equal(meta.nodeStatus.b, 'pending', 'the stopped node goes back to pending, not failed');
  assert.equal(meta.nodeStatus.out, 'pending');
  assert.ok(store.readLog(runId).some(e => e.event === 'run_stopped'));
  // The unwind must not clobber the cancelled state with a failure.
  assert.equal(store.readMeta(runId).stage, 'cancelled');
});

test('stop works against the mock adapter (a real adapter abort path)', async () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A', worker: { provider: 'mock', model: 'mock-small' } }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]);
  const runId = runner.start(flow);
  await waitFor(() => store.readMeta(runId).nodeStatus.a === 'active', { label: 'a in flight' });

  assert.deepEqual(runner.stop(runId), { ok: true });
  await waitFor(() => (!runner.stopRequests.has(runId) ? true : null), { label: 'walk unwound', timeoutMs: 5000 });
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
  assert.equal(meta.nodeStatus.a, 'pending');
});

test('stop settles a pending approval gate without hanging the walk', async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('g', 'aiStep', { goal: 'G', requiresApproval: true }),
      node('out', 'output')],
    [edge('in', 'g'), edge('g', 'out')]));
  await waitForStage(store, runId, ['awaiting_approval']);

  assert.deepEqual(runner.stop(runId), { ok: true });
  await settle(); // the gate's rejection path runs — muted by the stop
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled', 'a stopped gate is a cancel, not a rejection');
  assert.equal(meta.pendingNodeId, null);
  assert.equal(meta.pendingGateKind, null);
  assert.equal(runner.live.has(runId), false);
  assert.ok(!store.readLog(runId).some(e => e.event === 'stage_change' && e.stage === 'rejected'),
    'no rejected stage may be recorded after the stop');
});

test('stop releases a pause hold and cancels cleanly', async () => {
  const store = makeStore();
  let releaseB;
  setScript(({ prompt }) => {
    const g = goalOf(prompt);
    if (g === 'B') return new Promise(resolve => { releaseB = () => resolve('output B'); });
    return Promise.resolve(`output ${g}`);
  });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('c', 'aiStep', { goal: 'C' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'out')]));
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });
  runner.pause(runId);
  releaseB();
  await waitFor(() => (store.readMeta(runId).paused === true ? true : null), { label: 'paused' });

  assert.deepEqual(runner.stop(runId), { ok: true });
  await settle();
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
  assert.equal(meta.paused, false, 'the pause flag clears on stop');
  assert.equal(runner.live.has(runId), false);
});

test('stop requeues an agentTask that was mid-flight', async () => {
  const store = makeStore();
  setScript(({ system, signal }) =>
    roleOf(system) === 'executor' ? untilAborted(signal) : Promise.resolve('output'));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('at', 'agentTask', { title: 'T', goal: 'do it' }),
      node('out', 'output')],
    [edge('in', 'at'), edge('at', 'out')]));
  await waitFor(() => store.readTasks(runId)?.tasks.some(t => t.status === 'running'), { label: 'task claimed' });

  assert.deepEqual(runner.stop(runId), { ok: true });
  await waitFor(() => (!runner.stopRequests.has(runId) ? true : null), { label: 'walk unwound' });
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
  assert.equal(meta.nodeStatus.at, 'pending', 'the stopped agentTask goes back to pending');
  assert.equal(store.readTasks(runId).tasks[0].status, 'pending', 'its task requeues, not failed');
});

// --- pause() / resume() ---

test('pause holds after the current wave; resume continues the walk', async () => {
  const store = makeStore();
  let releaseB;
  setScript(({ prompt }) => {
    const g = goalOf(prompt);
    if (g === 'B') return new Promise(resolve => { releaseB = () => resolve('output B'); });
    return Promise.resolve(`output ${g}`);
  });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('c', 'aiStep', { goal: 'C' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'out')]));
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });

  // Pause requested mid-wave: the in-flight node finishes first. Double pause
  // is an idempotent ok.
  assert.deepEqual(runner.pause(runId), { ok: true });
  assert.deepEqual(runner.pause(runId), { ok: true });
  assert.equal(store.readMeta(runId).paused ?? false, false, 'not paused yet — the wave is still in flight');
  releaseB();
  await waitFor(() => (store.readMeta(runId).paused === true ? true : null), { label: 'paused' });
  assert.equal(store.readMeta(runId).nodeStatus.b, 'done', 'the current wave settled before the hold');
  assert.equal(store.readMeta(runId).nodeStatus.c, 'pending', 'the next wave has not started');
  assert.equal(runner.live.has(runId), true, 'a paused run is still live');

  runner.resume(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(store.readMeta(runId).paused, false, 'resume clears the pause flag');
  assert.equal(store.readNodeOutput(runId, 'c'), 'output C');
});

// --- restartNode ---

test('downstreamSet follows forward edges only (feedback edges excluded)', () => {
  const flow = makeFlow(
    [node('in', 'input'), node('a', 'aiStep'), node('b', 'aiStep'), node('c', 'aiStep'), node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'c'), edge('c', 'out'),
      { id: 'fb', source: 'c', target: 'a', sourceHandle: 'feedback' }]);
  assert.deepEqual([...downstreamSet(flow, 'a')].sort(), ['a', 'b', 'c', 'out'],
    'the reset set is the node plus its transitive forward downstream');
  assert.deepEqual([...downstreamSet(flow, 'c')].sort(), ['c', 'out'],
    'a feedback edge never drags its target into the reset set');
  assert.deepEqual([...upstreamSet(flow, 'c')].sort(), ['a', 'b', 'c', 'in'],
    'the branch keep set is the node plus its transitive ancestors');
});

test('restartNode resets the node and its downstream, keeps ancestors, re-runs with guidance', async () => {
  const store = makeStore();
  const calls = [];
  const prompts = [];
  setScript(({ prompt }) => {
    const g = goalOf(prompt);
    calls.push(g);
    prompts.push(prompt);
    return Promise.resolve(`output ${g}`);
  });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(linearFlow());
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.deepEqual(calls, ['A', 'B']);

  assert.deepEqual(runner.restartNode(runId, 'a', 'do it differently this time'), { ok: true });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.deepEqual(calls, ['A', 'B', 'A', 'B'], 'a re-ran, then its downstream re-ran on the fresh output');
  assert.match(prompts[2], /do it differently this time/, 'the guidance reached the retried prompt');
  assert.match(store.readNodeOutput(runId, 'retry-for-a'), /do it differently this time/);
  const meta = store.readMeta(runId);
  assert.equal(meta.nodeStatus.in, 'done', 'the completed ancestor stayed done');
  assert.equal(meta.stage, 'done');
  assert.ok(store.readLog(runId).some(e => e.event === 'node_restart' && e.node === 'a'));
});

// D39: the commonest reason a step fails is the model it was pointed at, so
// "run it again" is only useful with "run it again somewhere else".
test('restartNode re-points the failed step at a different model, for this run only', async () => {
  const store = makeStore();
  const seen = [];
  setScript(({ model }) => {
    seen.push(model);
    if (model === 'test-model') throw new Error('Codex CLI failed: unknown variant `priority`');
    return Promise.resolve(`output from ${model}`);
  });
  const runner = new StackRunner(store, testConfig());
  const authored = makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]);
  const runId = runner.start(authored);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  assert.match(store.readMeta(runId).error, /unknown variant/, 'the run records the provider’s own words');
  assert.deepEqual(store.readRetrospectives(runId).a.problems, ['Codex CLI failed: unknown variant `priority`']);

  // The re-pin echoes back the EFFECTIVE worker as well as the requested one
  // (WR-03): the UI may only claim "retried on B" when the backend resolved B.
  assert.deepEqual(
    runner.restartNode(runId, 'a', '', { provider: 'script', model: 'better-model' }),
    {
      ok: true,
      worker: { provider: 'script', model: 'better-model' },
      effectiveWorker: { provider: 'script', model: 'better-model' }
    });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  assert.deepEqual(seen, ['test-model', 'better-model'], 'the retry ran on the new model');
  assert.deepEqual(store.readFlow(runId).nodes.find(n => n.id === 'a').data.worker,
    { provider: 'script', model: 'better-model' }, 'the pin is written into the run’s flow');
  assert.equal(authored.nodes.find(n => n.id === 'a').data.worker, undefined,
    'the authored workflow keeps its own model');
  assert.ok(store.readLog(runId).some(e =>
    e.event === 'node_restart' && e.worker?.model === 'better-model'));
});

test('restartNode clears a pin back to the default, and refuses one on a node with no model', async () => {
  const store = makeStore();
  const seen = [];
  setScript(({ model }) => { seen.push(model); return Promise.resolve('ok'); });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A', worker: { provider: 'script', model: 'pinned' } }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.deepEqual(seen, ['pinned']);

  assert.throws(() => runner.restartNode(runId, 'in', '', { provider: 'script', model: 'x' }),
    /does not call a model/, 'an input node has no worker to change');

  // Clearing a pin also asked about the model, so it reports where the node
  // will now resolve — the configured default (WR-03).
  assert.deepEqual(runner.restartNode(runId, 'a', '', { provider: null, model: null }),
    { ok: true, effectiveWorker: { provider: 'script', model: 'test-model' } });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.deepEqual(seen, ['pinned', 'test-model'], 'clearing the pin falls back to the configured default');
  assert.equal(store.readFlow(runId).nodes.find(n => n.id === 'a').data.worker, undefined);
});

test('restartNode and branch refuse a live run', async () => {
  const store = makeStore();
  setScript(({ signal }) => untilAborted(signal));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }), node('a', 'aiStep', { goal: 'A' }), node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]));
  await waitFor(() => store.readMeta(runId).nodeStatus.a === 'active', { label: 'a in flight' });
  assert.throws(() => runner.restartNode(runId, 'a'), /run is live/);
  assert.throws(() => runner.branch(runId, 'a'), /run is live/);
  runner.stop(runId);
  // While the stop is still unwinding the run counts as live too.
  assert.throws(() => runner.restartNode(runId, 'a'), /run is live/);
  await waitFor(() => (!runner.stopRequests.has(runId) ? true : null), { label: 'walk unwound' });
  // Unwound: a cancelled run accepts a restart. It hangs again on the same
  // script — stop it to leave the store tidy.
  assert.deepEqual(runner.restartNode(runId, 'a'), { ok: true });
  assert.equal(runner.live.has(runId), true);
  assert.deepEqual(runner.stop(runId), { ok: true });
  await waitFor(() => (!runner.stopRequests.has(runId) ? true : null), { label: 'walk unwound again' });
  assert.equal(store.readMeta(runId).stage, 'cancelled');
});

// --- branch ---

test('branch forks a finished run: ancestors preserved, downstream re-runs', async () => {
  const store = makeStore();
  const calls = [];
  setScript(({ prompt }) => {
    const g = goalOf(prompt);
    if (g) calls.push(g);
    return Promise.resolve(`output ${g}`);
  });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(linearFlow());
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  calls.length = 0;

  const res = runner.branch(runId, 'a');
  assert.equal(res.ok, true);
  const branchId = res.runId;
  assert.notEqual(branchId, runId);

  const bMeta = store.readMeta(branchId);
  assert.deepEqual(bMeta.branchedFrom.runId, runId);
  assert.equal(bMeta.branchedFrom.nodeId, 'a');
  assert.ok(bMeta.branchedFrom.at, 'branchedFrom carries the fork instant');
  assert.match(bMeta.name, / \(branch\)$/, 'the branch lists with the name suffix');
  assert.equal(bMeta.nodeStatus.in, 'done', 'ancestors keep their status');
  assert.equal(bMeta.nodeStatus.a, 'done', 'the branch node keeps its status');
  assert.equal(bMeta.nodeStatus.b, 'pending', 'downstream re-runs');
  assert.equal(bMeta.nodeStatus.out, 'pending');
  assert.ok(store.readLog(branchId).some(e => e.event === 'run_branched' && e.from === runId && e.nodeId === 'a'));
  // Preserved upstream output survives as context; stale downstream output is gone.
  assert.equal(store.readNodeOutput(branchId, 'a'), 'output A');
  assert.equal(store.readNodeOutput(branchId, 'b'), null);

  assert.equal(await waitForStage(store, branchId, ['done', 'failed']), 'done');
  assert.deepEqual(calls, ['B'], 'only downstream model work re-runs');
  assert.ok(store.runSummaries().some(s => s.id === branchId && s.name.endsWith('(branch)')),
    'the branch appears in run:list');
});

test('branch of a branch works and points at its immediate source', async () => {
  const store = makeStore();
  setScript(({ prompt }) => Promise.resolve(`output ${goalOf(prompt)}`));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(linearFlow());
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const b1 = runner.branch(runId, 'a');
  assert.equal(await waitForStage(store, b1.runId, ['done', 'failed']), 'done');
  const b2 = runner.branch(b1.runId, 'b');
  assert.equal(store.readMeta(b2.runId).branchedFrom.runId, b1.runId);
  assert.equal(store.readMeta(b2.runId).branchedFrom.nodeId, 'b');
  assert.match(store.readMeta(b2.runId).name, /\(branch\) \(branch\)$/);
  assert.equal(await waitForStage(store, b2.runId, ['done', 'failed']), 'done');
});

// --- investigateNode ---

test('investigateNode returns raw artifacts plus a model summary', async () => {
  const store = makeStore();
  setScript(({ system, prompt }) => {
    if (roleOf(system) === 'node-investigator') {
      return Promise.resolve('Node B did the main work and looks healthy; nothing notable.');
    }
    return Promise.resolve(`output ${goalOf(prompt)}`);
  });
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }), node('b', 'aiStep', { goal: 'B' }), node('out', 'output')],
    [edge('in', 'b'), edge('b', 'out')]));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const inv = await runner.investigateNode(runId, 'b');
  assert.equal(inv.ok, true);
  assert.equal(inv.status, 'done');
  assert.match(inv.output, /output B/);
  assert.equal(inv.summary, 'Node B did the main work and looks healthy; nothing notable.');
  assert.ok(Array.isArray(inv.logTail) && inv.logTail.length > 0, 'log tail mentions the node');
  assert.equal(inv.model.provider, 'script', 'the model comes from the retrospective');
  assert.ok(inv.retro, 'the retrospective is included');

  // A node that never ran says so instead of crashing.
  const ghost = await runner.investigateNode(runId, 'ghost-node');
  assert.equal(ghost.ok, true);
  assert.equal(ghost.status, 'pending');
  assert.equal(ghost.output, null);
  assert.equal(ghost.retro, null);
});

test('investigateNode degrades to summaryError no-model without a configured model', async () => {
  const store = makeStore();
  setScript(({ prompt }) => Promise.resolve(`output ${goalOf(prompt)}`));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(makeFlow(
    [node('in', 'input', { text: 'brief' }), node('b', 'aiStep', { goal: 'B' }), node('out', 'output')],
    [edge('in', 'b'), edge('b', 'out')]));
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  // Break model resolution: the default worker names an unregistered provider.
  runner.config = { ...testConfig(), workers: { executor: { provider: 'nope', model: 'x' } } };
  const inv = await runner.investigateNode(runId, 'b');
  assert.equal(inv.ok, true);
  assert.equal(inv.summary, null);
  assert.equal(inv.summaryError, 'no-model');
  assert.match(inv.output, /output B/, 'raw data is still present');
  assert.equal(inv.status, 'done');
});
