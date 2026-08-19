// Retry model overrides that actually take effect (WR-03).
//
// The production failure: the retry UI sent a chosen worker to `restartNode`,
// which wrote it into the run's flow.json — but an `agentTask` executes from
// the already-materialized entry in tasks.json, and resetting a task's status
// never touched its persisted worker. So the UI reported "retried on B" while
// the executor called A again, and the retry reproduced the original failure on
// the original model.
//
// The regression tests deliberately cover GENERATED agentTask nodes, not only
// authored aiStep nodes: the authored path always worked, and testing it is
// what let this ship.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FlowRunner, effectiveWorkerFor } from '../core/flowRunner.js';
import { makeStore, setScript, testConfig, waitForStage } from './helpers.js';

const node = (id, type, data = {}) => ({ id, type, data, position: { x: 0, y: 0 } });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });
const makeFlow = (nodes, edges) => ({ id: 'f', name: 'F', nodes, edges });
const readLog = (store, runId) => store.readLog(runId) ?? [];

// --- the pure precedence rule ----------------------------------------------

test('a manual retry override outranks the persisted task worker', () => {
  const config = testConfig({ providerKeys: {} });
  const task = { worker: { provider: 'script', model: 'model-A' } };
  const flowNode = { type: 'agentTask', data: { worker: { provider: 'script', model: 'model-node' } } };

  // The override wins — this is the rung that used to be missing.
  assert.deepEqual(
    effectiveWorkerFor({ override: { provider: 'script', model: 'model-B' }, flowNode, task, config }),
    { worker: { provider: 'script', model: 'model-B' }, via: 'retry-override' });

  // Without one, the flow node's explicit worker wins over the task's.
  assert.deepEqual(
    effectiveWorkerFor({ flowNode, task, config }).worker,
    { provider: 'script', model: 'model-node' });

  // Without either, the persisted task worker stands.
  assert.deepEqual(
    effectiveWorkerFor({ flowNode: { type: 'agentTask', data: {} }, task, config }).worker,
    { provider: 'script', model: 'model-A' });

  // With nothing at all, routing decides.
  assert.equal(effectiveWorkerFor({ flowNode: { type: 'agentTask', data: {} }, config }).worker.provider, 'script');
});

// --- through the runner, on a GENERATED agentTask ---------------------------

async function failingAgentTaskRun() {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'do the thing' }),
     node('work', 'agentTask', { title: 'Work', goal: 'Do it', worker: { provider: 'script', model: 'model-A' } }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);

  const calls = [];
  setScript(({ model }) => {
    calls.push(model);
    if (model === 'model-A') throw new Error('model-A is broken');
    return '## Done\n\nHandled it.';
  });

  const runId = runner.start(flow, {});
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed');
  return { store, runner, runId, calls };
}

test('an agentTask retried on another model makes its next call on THAT model', async () => {
  const { store, runner, runId, calls } = await failingAgentTaskRun();
  assert.deepEqual(calls, ['model-A']);

  const res = runner.restartNode(runId, 'work', '', { provider: 'script', model: 'model-B' });
  assert.deepEqual(res.worker, { provider: 'script', model: 'model-B' });
  // The UI may only claim a re-point that the backend actually resolved.
  assert.deepEqual(res.effectiveWorker, { provider: 'script', model: 'model-B' });

  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(calls[calls.length - 1], 'model-B', 'the retry called the model the user chose');
  assert.equal(calls.includes('model-A'), true);
  assert.equal(calls.slice(1).includes('model-A'), false, 'the retry never called the failed model again');
});

test('the override is persisted and inspectable, and the planned worker is kept for audit', async () => {
  const { store, runner, runId } = await failingAgentTaskRun();
  runner.restartNode(runId, 'work', '', { provider: 'script', model: 'model-B' });

  const meta = store.readMeta(runId);
  assert.deepEqual(meta.workerOverrides.work, { provider: 'script', model: 'model-B' });

  const task = store.readTasks(runId).tasks[0];
  assert.deepEqual(task.worker, { provider: 'script', model: 'model-B' });
  assert.deepEqual(task.originalWorker, { provider: 'script', model: 'model-A' },
    'the originally planned worker survives the retry');
});

test('the run log records the requested and effective route, without a key', async () => {
  const { store, runner, runId } = await failingAgentTaskRun();
  runner.restartNode(runId, 'work', '', { provider: 'script', model: 'model-B' });
  await waitForStage(store, runId, ['done', 'failed']);

  const log = readLog(store, runId);
  const restart = log.find(e => e.event === 'node_restart');
  assert.deepEqual(restart.requestedWorker, { provider: 'script', model: 'model-B' });
  assert.deepEqual(restart.effectiveWorker, { provider: 'script', model: 'model-B' });

  // The executor says which worker it actually started on, and that a retry
  // override is in force.
  const started = log.filter(e => e.event === 'node_start' && e.node?.startsWith('executor:'));
  const last = started[started.length - 1];
  assert.equal(last.worker.model, 'model-B');
  assert.equal(last.retryOverride, true);
  assert.deepEqual(last.originalWorker, { provider: 'script', model: 'model-A' });
  assert.doesNotMatch(JSON.stringify(log), /apiKey/);
});

test('a plain retry with no model change keeps the original effective worker', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
     node('work', 'agentTask', { title: 'Work', goal: 'Do it', worker: { provider: 'script', model: 'model-A' } }),
     node('out', 'output')],
    [edge('in', 'work'), edge('work', 'out')]);

  const calls = [];
  let failFirst = true;
  setScript(({ model }) => {
    calls.push(model);
    if (failFirst) { failFirst = false; throw new Error('transient'); }
    return '## Done';
  });

  const runId = runner.start(flow, {});
  await waitForStage(store, runId, ['done', 'failed']);

  // A plain "run it again" asked nothing about the model, so it gets the same
  // bare { ok: true } every existing caller matches on — no echo to confirm.
  const res = runner.restartNode(runId, 'work', 'try harder');
  assert.deepEqual(res, { ok: true });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.ok(calls.every(m => m === 'model-A'), 'and it runs on the original worker');
  assert.equal(store.readMeta(runId).workerOverrides?.work, undefined);
});

test('clearing a retry pin restores the originally planned worker', async () => {
  const { store, runner, runId } = await failingAgentTaskRun();
  runner.restartNode(runId, 'work', '', { provider: 'script', model: 'model-B' });
  await waitForStage(store, runId, ['done', 'failed']);
  assert.deepEqual(store.readTasks(runId).tasks[0].worker, { provider: 'script', model: 'model-B' });

  // `{ provider: null }` is how the UI clears a pin back to normal routing.
  const res = runner.restartNode(runId, 'work', '', { provider: null, model: null });
  assert.equal(store.readMeta(runId).workerOverrides.work, undefined);
  const task = store.readTasks(runId).tasks[0];
  assert.deepEqual(task.worker, { provider: 'script', model: 'model-A' }, 'the planned worker is back');
  assert.equal(task.originalWorker, undefined);
  assert.deepEqual(res.effectiveWorker, { provider: 'script', model: 'model-A' });
});

test('an aiStep retry keeps honoring the same UI contract', async () => {
  const store = makeStore();
  const runner = new FlowRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'go' }),
     node('step', 'aiStep', { role: 'execute', worker: { provider: 'script', model: 'model-A' } }),
     node('out', 'output')],
    [edge('in', 'step'), edge('step', 'out')]);

  const calls = [];
  setScript(({ model }) => {
    calls.push(model);
    if (model === 'model-A') throw new Error('broken');
    return 'done';
  });

  const runId = runner.start(flow, {});
  await waitForStage(store, runId, ['done', 'failed']);
  const res = runner.restartNode(runId, 'step', '', { provider: 'script', model: 'model-B' });
  assert.deepEqual(res.effectiveWorker, { provider: 'script', model: 'model-B' });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(calls[calls.length - 1], 'model-B');
});

test('re-pinning a node that calls no model is refused, not silently ignored', async () => {
  const { runner, runId } = await failingAgentTaskRun();
  assert.throws(
    () => runner.restartNode(runId, 'in', '', { provider: 'script', model: 'model-B' }),
    /does not call a model/);
});
