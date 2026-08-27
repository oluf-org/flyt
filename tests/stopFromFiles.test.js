// stop() from the files: a run whose starting CLI process is gone must still
// be stoppable, and a run genuinely owned by a live process must be refused
// rather than written over. This is the durable path resolveGate() already has
// via resumeFromGate() — stop() used to answer `not-live` for both, and
// bin/flyt.js printed success while touching nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StackRunner } from '../core/stackRunner.js';
import { makeStore, setScript, testConfig, waitForStage, makeFlow, node, edge } from './helpers.js';

const settle = (ms = 100) => new Promise(r => setTimeout(r, ms));

function gateFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('g', 'aiStep', { goal: 'G', requiresApproval: true }),
      node('out', 'output')],
    [edge('in', 'g'), edge('g', 'out')]);
}

// Simulate "the process died": stage awaiting_approval on disk plus a stale
// lease (beatAt far in the past) — what isRunLive reads to conclude nobody
// owns the run.
async function parkedRunWithStaleLease() {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(gateFlow());
  await waitForStage(store, runId, ['awaiting_approval']);
  store.writeLease(runId, {
    pid: 999999999, host: os.hostname(),
    startedAt: new Date(Date.now() - 600000).toISOString(),
    beatAt: Date.now() - 600000 // ten minutes without a beat: stale
  });
  return { store, runId };
}

test('stop stops a headless run parked at a gate whose process is gone (stale lease)', async () => {
  const { store, runId } = await parkedRunWithStaleLease();
  const runner = new StackRunner(store, testConfig()); // a fresh process's worth of nothing live

  assert.deepEqual(runner.stop(runId), { ok: true, fromFiles: true });

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
  assert.equal(meta.pendingNodeId, null);
  assert.equal(meta.pendingGateKind, null);
  assert.equal(store.readLease(runId), null, 'the stale lease is released');
  assert.ok(store.readLog(runId).some(e => e.event === 'run_stopped'));
});

test('stop from files requeues stuck tasks and resets unfinished nodes', async () => {
  const { store, runId } = await parkedRunWithStaleLease();
  const runner = new StackRunner(store, testConfig());
  store.writeTasks(runId, { tasks: [{ id: 'task-1', status: 'running' }] });

  assert.deepEqual(runner.stop(runId), { ok: true, fromFiles: true });

  assert.deepEqual(store.readTasks(runId).tasks[0].status, 'pending', 'claimed tasks are requeued');
  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'cancelled');
});

test('stop refuses a run owned by a live foreign process instead of writing over it', async () => {
  const { store, runId } = await parkedRunWithStaleLease();
  const runner = new StackRunner(store, testConfig());
  // A fresh beat from a live holder: isRunLive probes this very pid and
  // finds it alive — because it is; it is this test.
  store.writeLease(runId, { pid: process.pid, host: os.hostname(), beatAt: Date.now() });

  const res = runner.stop(runId);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'owned-by-live-process');
  assert.match(res.message ?? '', /live process/, 'the refusal names why');

  const meta = store.readMeta(runId);
  assert.equal(meta.stage, 'awaiting_approval', 'the parked stage is untouched');
  assert.ok(meta.pendingNodeId, 'the pending gate is untouched');
  assert.ok(!store.readLog(runId).some(e => e.event === 'run_stopped'), 'no stop was recorded');
});

test('stop of an unknown or already-ended run reports failure honestly', async () => {
  const store = makeStore();
  setScript(() => 'step output');
  const runner = new StackRunner(store, testConfig());
  // Fields, not deepEqual: the result also carries a `message`, which is the
  // half the CLI prints, and an exact-shape assertion here would make adding a
  // better sentence look like a regression. The rest of this test already
  // checks fields.
  const unknown = runner.stop('no-such-run');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown-run');
  assert.match(unknown.message, /no-such-run/);

  // Its OWN store: parkedRunWithStaleLease makes a fresh one, and using the
  // outer store here read a run that only exists in the other.
  const parked = await parkedRunWithStaleLease();
  parked.store.setStage(parked.runId, 'done', {});
  const res = new StackRunner(parked.store, testConfig()).stop(parked.runId);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'already-ended');
  assert.equal(parked.store.readMeta(parked.runId).stage, 'done', 'a done run is not rewritten as cancelled');
});

test('approve falls back to resumeFromGate for a run whose process is gone', async () => {
  const { store, runId } = await parkedRunWithStaleLease();
  const runner = new StackRunner(store, testConfig());
  runner.approvePlan(runId); // no in-process gate -> resumeFromGate drives it from meta.json
  await waitForStage(store, runId, ['execution', 'awaiting_approval', 'done']);
  await settle();
  assert.notEqual(store.readMeta(runId).stage, 'awaiting_approval', 'the gate moved off awaiting_approval');
});
