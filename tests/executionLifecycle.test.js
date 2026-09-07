import test from 'node:test';
// Regression coverage for all fault boundaries reproduced by the running-state review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callModel, registerProvider } from '../core/adapters/index.js';
import { restartStackBlock } from '../core/kernelHost.js';
import { RunController } from '../core/runController.js';
import { GoalController } from '../core/goalController.js';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { runView } from '../src/v2/runView.js';
import { createKernel, flytBlocks, flytStackRunner, provideSeam, JsonlSessionStore, readSessionLogFile } from '#kernel';

test('running-state fault regressions', { timeout: 15000 }, async () => {
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-running-state-review-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async fn => { for (let n = 0; n < 200; n++) { if (fn()) return; await sleep(5); } throw new Error('Probe did not reach its boundary'); };
const record = (name, result) => { results.push({ name, ...result }); console.log(JSON.stringify(results.at(-1))); };
const leaf = id => ({ kind: 'block', id, use: 'probe:work', config: {}, outputs: [], position: { line: 1, path: id } });
const sequence = children => ({ kind: 'sequence', id: 'root', children, position: { line: 0, path: '' } });

async function kernelFixture(name, execute, intercept = async () => {}, tree = sequence([leaf('one'), leaf('two')])) {
  const kernel = createKernel();
  const store = new JsonlSessionStore(path.join(root, name));
  const events = [];
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin({ name: `probe-sessions-${name}`, apply(ctx) {
    return provideSeam(ctx, 'sessions', {
      async open(id) {
        const session = await store.open(id);
        return {
          runId: id, read: (...args) => session.read(...args), head: () => session.head(),
          deriveMessages: (...args) => session.deriveMessages(...args),
          async append(event) { await intercept(event); const written = await session.append(event); events.push(written); return written; },
        };
      }, read: id => store.read(id), list: () => store.list(),
    });
  } });
  kernel.ctx.blocks.register({ use: 'probe:work', title: 'Probe', category: 'utility', settings: {}, ceiling: [], execute });
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => tree } });
  return { kernel, events };
}

try {
  // Abort clears both deadlines without settling the Promise raced by callModel.
  {
    const entered = deferred(), release = deferred(), abort = new AbortController();
    registerProvider('review-ignore-abort', async () => { entered.resolve(); await release.promise; return { text: 'late', usage: {} }; });
    const pending = callModel({ provider: 'review-ignore-abort', model: 'probe', prompt: 'test', signal: abort.signal,
      timeout: { idleMs: 40, hardMs: 80 }, retry: { attempts: 1 } });
    const outcome = pending.then(() => 'resolved', () => 'rejected');
    await entered.promise; abort.abort();
    const afterAbort = await Promise.race([outcome, sleep(150).then(() => 'still pending')]);
    assert.equal(afterAbort, 'rejected');
    release.resolve(); await outcome;
    record('abort-ignoring-provider', { afterAbort, hardDeadlineMs: 80, observedAfterMs: 150 });
  }

  // Exercise the actual application read endpoints with an orphaned session.
  {
    const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const engine = createEngine({ projectRoot: repo, dataRoot: path.join(root, 'data'), userDataDir: path.join(root, 'user') });
    const api = createApi(engine);
    try {
      const project = await api.invoke('project:open', { folder: workspace });
      const store = engine.registry.get(project.id).store;
      const session = await new JsonlSessionStore(store.rootDir).open('orphan');
      await session.append({ type: 'run.created', data: { runId: 'orphan', stackId: 'probe', workspace } });
      await session.append({ type: 'run.stage', data: { stage: 'execution' } });
      await session.append({ type: 'block.status', data: { blockId: 'one', status: 'active' } });
      const snapshot = await api.invoke('run:snapshot', { projectId: project.id, runId: 'orphan' });
      const listed = await api.invoke('run:list', { projectId: project.id });
      const stopped = await api.invoke('run:stop', { projectId: project.id, runId: 'orphan' });
      assert.equal(snapshot.meta.stage, 'interrupted'); assert.equal(stopped.ok, true);
      assert.equal(listed.find(row => row.id === 'orphan').stage, 'interrupted');
      record('orphan-read-and-stop', { snapshotStage: snapshot.meta.stage, listStage: listed.find(row => row.id === 'orphan').stage, stop: stopped.code });
    } finally { await api.shutdown(); engine.telemetry.close(); }
  }

  // The pause flag is set before the pausing event is durable. Delay that write.
  {
    const entered = deferred(), finishBlock = deferred(), pausingWrite = deferred(), releaseWrite = deferred();
    const f = await kernelFixture('pause-order', async ctx => {
      if (ctx.blockId === 'one') { entered.resolve(); await finishBlock.promise; }
      return { status: 'done', output: ctx.blockId };
    }, async event => { if (event.type === 'run.stage' && event.data.stage === 'pausing') { pausingWrite.resolve(); await releaseWrite.promise; } });
    try {
      const run = await f.kernel.ctx.agents.start({ id: 'probe', runId: 'pause-order' }, '');
      await entered.promise;
      const pause = f.kernel.ctx.agents.pause(run.runId);
      await pausingWrite.promise; finishBlock.resolve(); releaseWrite.resolve();
      await until(() => f.events.some(event => event.type === 'run.stage' && event.data.stage === 'paused'));
      releaseWrite.resolve(); await pause;
      const stages = f.events.filter(event => event.type === 'run.stage').map(event => event.data.stage);
      const view = runView({ others: f.events, steps: [] });
      assert.deepEqual(stages.slice(-2), ['pausing', 'paused']); assert.equal(view.resumable, true);
      await f.kernel.ctx.agents.continue(run.runId); await run.settled();
      record('pause-event-order', { stages, displayedStage: view.stage, resumeVisible: view.resumable });
    } finally { releaseWrite.resolve(); finishBlock.resolve(); await f.kernel.dispose(); }
  }

  // Stop can append a nonterminal stage after the execution already completed.
  {
    const entered = deferred(), finishBlock = deferred(), stoppingWrite = deferred(), releaseWrite = deferred();
    const f = await kernelFixture('stop-order', async () => {
      entered.resolve(); await finishBlock.promise; return { status: 'done', output: 'done' };
    }, async event => { if (event.type === 'run.stage' && event.data.stage === 'stopping') { stoppingWrite.resolve(); await releaseWrite.promise; } }, sequence([leaf('one')]));
    try {
      const run = await f.kernel.ctx.agents.start({ id: 'probe', runId: 'stop-order' }, '');
      await entered.promise;
      const stop = f.kernel.ctx.agents.stop(run.runId, 'user stop');
      await stoppingWrite.promise; finishBlock.resolve(); releaseWrite.resolve(); const outcome = await run.settled();
      releaseWrite.resolve(); await stop;
      const stages = f.events.filter(event => event.type === 'run.stage').map(event => event.data.stage);
      assert.equal(stages.at(-1), 'stopped'); assert.equal(outcome.status, 'stopped');
      record('stop-event-order', { stages, executionOutcome: outcome.status, kernelLive: Boolean(f.kernel.ctx.agents.get(run.runId)) });
    } finally { releaseWrite.resolve(); finishBlock.resolve(); await f.kernel.dispose(); }
  }

  // The application controller and kernel accept concurrent starts of one ID.
  {
    let calls = 0;
    const release = deferred();
    const f = await kernelFixture('duplicate-start', async () => { calls++; await release.promise; return { status: 'done', output: 'done' }; }, undefined, sequence([leaf('one')]));
    try {
      const controller = new RunController({
        bootHost: async () => ({ ctx: f.kernel.ctx, dispose: async () => {} }),
        runsRootForProject: () => path.join(root, 'duplicate-start'),
        storeForProject: () => ({ writeLease() {}, clearLease() {} }), snapshotLive: async () => ({}),
        startRun: async ({ id }) => ({ runId: id, run: await f.kernel.ctx.agents.start({ id: 'probe', runId: id }, '') }),
      });
      const launched = await Promise.allSettled([1, 2].map(() => controller.start({ projectId: 'p', runId: 'duplicate-start', stackId: 'probe' })));
      assert.equal(launched.filter(item => item.status === 'rejected').length, 1);
      const runs = launched.filter(item => item.status === 'fulfilled').map(item => item.value.run);
      await until(() => calls === 1);
      assert.equal(runs.length, 1); release.resolve(); await Promise.all(runs.map(run => run.settled()));
      record('duplicate-start', { sameRunId: true, distinctExecutions: runs.length, calls });
      await controller.shutdown();
    } finally { release.resolve(); await f.kernel.dispose(); }
  }

  // A settled run remains live throughout an arbitrarily slow cleanup hook.
  {
    const finish = deferred(), cleanup = deferred(), beganCleanup = deferred();
    let beats = 0;
    const controller = new RunController({
      bootHost: async () => ({ ctx: { agents: { stop: async () => false }, subprocess: { terminateOwner: async () => { beganCleanup.resolve(); await cleanup.promise; } } }, dispose: async () => {} }),
      startRun: async () => ({ runId: 'cleanup', run: { runId: 'cleanup', settled: () => finish.promise } }),
      runsRootForProject: () => path.join(root, 'cleanup'), storeForProject: () => ({ writeLease: () => beats++, clearLease: () => {} }), snapshotLive: async () => ({}),
    });
    await controller.start({ projectId: 'p', stackId: 'probe' });
    const settled = controller.get('p', 'cleanup').settlement;
    finish.resolve({ status: 'done' }); await beganCleanup.promise;
    const live = controller.isLive('p', 'cleanup'); const stop = await controller.stop('p', 'cleanup');
    assert.equal(live, false); assert.equal(stop.ok, true);
    assert.equal(controller.lifecycle('p', 'cleanup').cleanup, 'running');
    record('cleanup-is-live', { executionOutcome: 'done', controllerLive: live, stop: stop.code, leaseWritten: beats > 0 });
    cleanup.resolve(); await settled;
  }

  // A host being composed is absent from the controller's shutdown snapshot.
  {
    const bootEntered = deferred(), bootRelease = deferred(), finish = deferred();
    const controller = new RunController({
      bootHost: async () => { bootEntered.resolve(); await bootRelease.promise; return {
        ctx: { agents: { stop: async () => { finish.resolve({ status: 'stopped' }); return true; } } }, dispose: async () => {},
      }; },
      startRun: async () => ({ runId: 'late-start', run: { runId: 'late-start', settled: () => finish.promise } }),
      runsRootForProject: () => path.join(root, 'late-start'), storeForProject: () => ({ writeLease() {}, clearLease() {} }), snapshotLive: async () => ({}),
    });
    const launch = controller.start({ projectId: 'p', runId: 'late-start', stackId: 'probe' });
    const rejected = assert.rejects(launch, /cancelled|closed/);
    await bootEntered.promise;
    const shutdown = await controller.shutdown();
    bootRelease.resolve(); await rejected;
    assert.equal(shutdown.stopped, 0); assert.equal(controller.isLive('p', 'late-start'), false);
    record('launch-outlives-shutdown', { shutdownStopped: shutdown.stopped, liveAfterShutdown: false });
    await controller.shutdown();
  }

  // Goal liveness ignores a live owner from a different controller.
  {
    const dir = path.join(root, 'goals'); fs.mkdirSync(dir);
    const project = () => ({ id: 'p', store: { rootDir: dir } });
    const controller = new GoalController({ project, runs: {} });
    const state = { id: 'owned', projectId: 'p', status: 'running', elapsedMs: 0, activeSince: Date.now(), createdAt: new Date().toISOString() };
    controller.save(state);
    const release = controller.acquire(state);
    try {
      const shown = controller.get('p', 'owned');
      let stopError;
      try { await controller.control({ projectId: 'p', goalId: 'owned', action: 'stop' }); } catch (error) { stopError = error.message; }
      assert.equal(shown.status, 'running'); assert.equal(shown.live, true); assert.equal(shown.recoverable, false); assert.equal(stopError, undefined);
      record('goal-owner-disagreement', { displayedStatus: shown.status, recoverable: shown.recoverable, stopError });
    } finally { release(); }
  }

  // Goal child recovery parses JSONL before the robust kernel repair can run.
  {
    const dir = path.join(root, 'torn'); fs.mkdirSync(dir);
    const workspace = path.join(dir, 'workspace'); fs.mkdirSync(workspace);
    const project = () => ({ id: 'p', folder: workspace, store: { rootDir: dir, runDir: id => path.join(dir, id) } });
    let resumes = 0, retries = 0;
    const launchedChild = () => ({ run: { settled: async () => ({ status: 'done' }) } });
    const controller = new GoalController({ project, runs: { get: () => null, resume: async () => { resumes++; return launchedChild(); }, restartBlock: async args => { assert.equal(args.blockId, 'repeat-until'); retries++; return launchedChild(); } } });
    controller.validateSource = async () => ({ id: 'probe', root: sequence([leaf('one')]) });
    const state = { id: 'torn', projectId: 'p', status: 'running', elapsedMs: 0, calls: 0, iteration: 0, activeRevision: 1,
      workspace: { path: workspace }, contract: { objective: 'test', requiredPaths: [], limits: { calls: 10, minutes: 1, iterations: 2, usd: null }, tools: [], worker: { model: 'mock' } },
      activeChild: { runId: 'child', phase: 'iteration-1', source: 'unused', input: '', workspace } };
    const session = await new JsonlSessionStore(dir).open('child');
    await session.append({ type: 'run.created', data: { runId: 'child', stackId: 'probe' } });
    await session.append({ type: 'run.stage', data: { stage: 'execution' } });
    const file = path.join(dir, 'child', 'session.jsonl'); fs.appendFileSync(file, '{"seq":3,"type":');
    assert.equal(readSessionLogFile(file).events.length, 2);
    let error;
    try { await controller.child({ state, began: Date.now() }, 'iteration-1', 'unused', ''); } catch (caught) { error = caught; }
    assert.equal(error, undefined); assert.equal(resumes, 1);
    record('goal-torn-tail-recovery', { recovered: !error, resumeInvocations: resumes, kernelReadableEvents: 2 });

    // Until exhaustion is a valid container failure, but retry validates leaves only.
    state.activeChild = { runId: 'child', phase: 'iteration-2', source: 'unused', input: '', workspace };
    const container = { kind: 'until', id: 'repeat-until', max: 1, condition: { source: 'one.success', operator: 'is', literal: true }, children: [leaf('one')] };
    controller.validateSource = async () => ({ id: 'probe', root: sequence([container]) });
    fs.writeFileSync(file, '');
    const failed = await new JsonlSessionStore(dir).open('child');
    await failed.append({ type: 'run.created', data: { runId: 'child', stackId: 'probe' } });
    await failed.append({ type: 'block.status', data: { blockId: 'one', status: 'done' } });
    await failed.append({ type: 'block.status', data: { blockId: 'repeat-until', kind: 'until', status: 'failed' } });
    await failed.append({ type: 'run.error', data: { blockId: 'repeat-until', error: 'Until exhausted its passes' } });
    await failed.append({ type: 'run.stage', data: { stage: 'failed' } });
    try { await controller.child({ state, began: Date.now() }, 'iteration-2', 'unused', ''); } catch (caught) { error = caught; }
    assert.equal(error, undefined); assert.equal(retries, 1);
    record('goal-container-retry', { recovered: !error, retryInvocations: retries });
  }

  // A container retry invalidates its scoped descendants, preserving predecessors.
  {
    let accepted = false;
    const calls = [];
    const container = { kind: 'until', id: 'repeat', max: 1, condition: { source: 'one.success', operator: 'is', literal: true }, children: [leaf('one')] };
    const f = await kernelFixture('container-replay', async ctx => {
      calls.push(ctx.blockId); return { status: 'done', output: 'result', structured: { success: accepted } };
    }, undefined, sequence([leaf('before'), container]));
    try {
      const run = await f.kernel.ctx.agents.start({ id: 'probe', runId: 'container-replay' }, '');
      assert.equal((await run.settled()).status, 'failed');
      accepted = true;
      const retried = await restartStackBlock({ ctx: f.kernel.ctx }, run.runId, 'repeat');
      assert.equal((await retried.run.settled()).status, 'done');
      assert.deepEqual(calls, ['before', 'one', 'one']);
    } finally { await f.kernel.dispose(); }
  }
  assert.equal(results.length, 10);
} finally {
  assert(path.dirname(root) === fs.realpathSync(os.tmpdir()) || path.dirname(root) === os.tmpdir());
  fs.rmSync(root, { recursive: true, force: true });
}

});
