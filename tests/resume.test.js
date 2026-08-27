// Restart resilience (V1 task 7, D17): completed steps survive the app dying,
// and resuming continues the walk from the right point instead of redoing work.
//
// A crash is simulated the way the app actually experiences one: the model call
// in flight never resolves (its call stack is gone), and a FRESH StackRunner is
// constructed over the SAME store — process state lost, file state intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { StackRunner } from '../core/stackRunner.js';
import { makeStore, setScript, roleOf, testConfig, waitFor, waitForStage, makeFlow, node, edge } from './helpers.js';

const goalOf = prompt => (prompt.match(/GOAL:\n(.+)/) ?? [])[1]?.trim();
const NEVER = () => new Promise(() => {}); // a call whose stack died with the app

// in -> a -> b -> out, where `b` hangs the first time it is called.
function crashingFlow() {
  return makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('a', 'aiStep', { goal: 'A' }),
      node('b', 'aiStep', { goal: 'B' }),
      node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]);
}

test('resume continues an interrupted run without re-executing completed nodes', async () => {
  const store = makeStore();
  const calls = [];
  let hang = true;
  setScript(async ({ prompt }) => {
    const goal = goalOf(prompt);
    calls.push(goal);
    if (goal === 'B' && hang) { hang = false; return NEVER(); } // the app dies here
    return `output ${goal}`;
  });

  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(crashingFlow());
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });
  assert.equal(store.readMeta(runId).nodeStatus.a, 'done', 'a finished before the crash');
  assert.deepEqual(calls, ['A', 'B']);

  // --- app restart ---
  // A crash is the holder's liveness lease going away (D40): the walk is still
  // suspended in THIS process, so without this the run is — correctly — still
  // live, and a second runner must leave it alone. Dropping the lease is what a
  // dead process's would do on its own.
  store.clearLease(runId);
  const restarted = new StackRunner(store, testConfig());
  assert.deepEqual(restarted.reconcileInterrupted(), [runId], 'the run should be flagged interrupted');
  assert.equal(store.readMeta(runId).interrupted, true);
  // Reopening an interrupted run must read honestly: the node that died
  // mid-flight is no longer "active" (nothing is running, so nothing spins),
  // while the finished node keeps its result.
  assert.equal(store.readMeta(runId).nodeStatus.b, 'pending', 'a dead node must not still look active');
  assert.equal(store.readMeta(runId).nodeStatus.a, 'done');

  restarted.resume(runId);
  assert.equal(store.readMeta(runId).interrupted, false, 'resuming clears the flag');

  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  // The crux: A ran once (kept), B ran again (it never finished).
  assert.deepEqual(calls, ['A', 'B', 'B']);
  assert.equal(store.readNodeOutput(runId, 'a'), 'output A');
  assert.equal(store.readNodeOutput(runId, 'b'), 'output B');
  assert.ok(store.readNodeOutput(runId, 'out').includes('output B'), 'the run finished past the crash point');
});

test('reconcileInterrupted flags only runs that were actually cut off', async () => {
  const store = makeStore();
  setScript(async ({ prompt }) => `output ${goalOf(prompt)}`);
  const runner = new StackRunner(store, testConfig());

  // A run that finished cleanly.
  const doneRun = runner.start(makeFlow(
    [node('in', 'input', { text: 'b' }), node('a', 'aiStep', { goal: 'A' }), node('out', 'output')],
    [edge('in', 'a'), edge('a', 'out')]));
  assert.equal(await waitForStage(store, doneRun, ['done', 'failed']), 'done');

  // A run paused at an approval gate: it already has a way back (approve /
  // reject), so it must NOT be offered as resumable.
  const gateRun = runner.start(makeFlow(
    [node('in', 'input', { text: 'b' }),
      node('g', 'aiStep', { goal: 'G', requiresApproval: true }), node('out', 'output')],
    [edge('in', 'g'), edge('g', 'out')]));
  await waitForStage(store, gateRun, ['awaiting_approval']);

  const restarted = new StackRunner(store, testConfig());
  assert.deepEqual(restarted.reconcileInterrupted(), [], 'neither run was interrupted');
  assert.ok(!store.readMeta(doneRun).interrupted);
  assert.ok(!store.readMeta(gateRun).interrupted);
  assert.match(restarted.resumeBlocker(doneRun), /already finished \(done\)/);
  assert.match(restarted.resumeBlocker(gateRun), /approval gate/);
});

test('a live run is never resumable from underneath itself', async () => {
  const store = makeStore();
  setScript(async ({ prompt }) => (goalOf(prompt) === 'B' ? NEVER() : `output ${goalOf(prompt)}`));
  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(crashingFlow());
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });

  // Same process: the run is still being walked, so it isn't interrupted.
  assert.deepEqual(runner.reconcileInterrupted(), []);
  assert.match(runner.resumeBlocker(runId), /already running/);
  assert.throws(() => runner.resume(runId), /already running/);
});

test('resume requeues tasks that were mid-flight, including agent-spawned ones', async () => {
  const store = makeStore();
  let hang = true;
  setScript(async ({ system, prompt }) => {
    if (roleOf(system) === 'executor') {
      if (hang) { hang = false; return NEVER(); } // the app dies inside the task
      return 'Task done.';
    }
    return `output ${goalOf(prompt)}`;
  });

  const runner = new StackRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('at', 'agentTask', { title: 'T', goal: 'do it' }),
      node('out', 'output')],
    [edge('in', 'at'), edge('at', 'out')]);
  const runId = runner.start(flow);
  await waitFor(() => store.readTasks(runId)?.tasks.some(t => t.status === 'running'), { label: 'task claimed' });

  // A task claimed but never finished, plus a task an agent spawned that never
  // got picked up — both must return to the queue on resume.
  const doc = store.readTasks(runId);
  doc.tasks.push({
    id: 'task-99', title: 'spawned', goal: 'spawned work', inputs: [], constraints: [],
    dependsOn: [], worker: { provider: 'script', model: 'test-model' }, status: 'running'
  });
  store.writeTasks(runId, doc);

  const restarted = new StackRunner(store, testConfig());
  restarted.reconcileInterrupted();
  restarted.resume(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  const finished = store.readTasks(runId).tasks;
  assert.ok(finished.every(t => t.status === 'done'),
    `every requeued task should have run: ${finished.map(t => `${t.id}:${t.status}`).join(' ')}`);
});

test('an agentTask whose task already finished is not re-run on resume', async () => {
  const store = makeStore();
  let executorCalls = 0;
  setScript(async ({ system, prompt }) => {
    if (roleOf(system) === 'executor') { executorCalls++; return 'Task done.'; }
    return `output ${goalOf(prompt)}`;
  });

  const runner = new StackRunner(store, testConfig());
  const flow = makeFlow(
    [node('in', 'input', { text: 'brief' }),
      node('at', 'agentTask', { title: 'T', goal: 'do it' }),
      node('out', 'output')],
    [edge('in', 'at'), edge('at', 'out')]);
  const runId = runner.start(flow);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(executorCalls, 1);

  // Rewind to the narrow crash window: the task recorded 'done', but the app
  // died before its node was marked done.
  const meta = store.readMeta(runId);
  store.writeMeta(runId, {
    ...meta, stage: 'execution',
    nodeStatus: { ...meta.nodeStatus, at: 'active', out: 'pending' }
  });

  const restarted = new StackRunner(store, testConfig());
  assert.deepEqual(restarted.reconcileInterrupted(), [runId]);
  restarted.resume(runId);
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');

  // The task's work is honored, not repeated.
  assert.equal(executorCalls, 1, 'the finished task must not run a second time');
  assert.equal(store.readMeta(runId).nodeStatus.at, 'done');
});

// The defect the liveness lease exists to fix (D40).
//
// `reconcileInterrupted` ran on every project open and decided "nothing is live
// in this process" meant "nothing is live anywhere". The moment a second
// process existed — a `flyt` command inspecting a headless run, a window opened
// beside one — that read a healthy in-flight run as a crashed one: flagged it
// interrupted and rewound every non-done node to 'pending' underneath the walk
// still working on it. Observed live: `flyt why <runId>` on a running fan-out
// requeued its lanes.
//
// Which made the headless front door self-defeating. You could start a run
// without the app and then not look at it.
test('a second process must not mark a LIVE run interrupted', async () => {
  const store = makeStore();
  let release;
  setScript(async ({ prompt }) => (goalOf(prompt) === 'B' ? NEVER() : `output ${goalOf(prompt)}`));

  const runner = new StackRunner(store, testConfig());
  const runId = runner.start(crashingFlow());
  await waitFor(() => store.readMeta(runId).nodeStatus.b === 'active', { label: 'b in flight' });

  // A whole separate StackRunner over the same store — a `flyt` invocation, or
  // the desktop app opening the same project.
  const observer = new StackRunner(store, testConfig());
  assert.deepEqual(observer.reconcileInterrupted(), [], 'a live run is not an interrupted one');
  assert.notEqual(store.readMeta(runId).interrupted, true);
  assert.equal(store.readMeta(runId).nodeStatus.b, 'active', 'the in-flight node must not be rewound');
  assert.equal(store.readMeta(runId).nodeStatus.a, 'done');

  // ...and once the holder is gone, the same call reaches the opposite verdict.
  store.clearLease(runId);
  assert.deepEqual(observer.reconcileInterrupted(), [runId]);
  assert.equal(store.readMeta(runId).nodeStatus.b, 'pending');
  release?.();
});

// A lease left behind by a process that died without releasing must not pin a
// run as live forever — the whole recovery path depends on being able to tell.
test('a lease whose holder is gone does not keep a dead run looking alive', () => {
  const store = makeStore();
  const runner = new StackRunner(store, testConfig());
  const runId = store.createRun('p');
  store.writeMeta(runId, { ...store.readMeta(runId), flowId: 'f', stage: 'execution' });

  // A pid that cannot exist, beating just now: the timestamp says fresh, the
  // process says otherwise, and the process wins on this host.
  store.writeLease(runId, { pid: 0x7ffffff0, host: os.hostname(), beatAt: Date.now() });
  assert.equal(runner.isRunLive(runId), false);

  // A stale beat from another machine, where no pid check is possible.
  store.writeLease(runId, { pid: 1, host: 'some-other-host', beatAt: Date.now() - 10 * 60 * 1000 });
  assert.equal(runner.isRunLive(runId), false);
  store.writeLease(runId, { pid: 1, host: 'some-other-host', beatAt: Date.now() });
  assert.equal(runner.isRunLive(runId), true);
});
