// The run view's derived data (V1 task 9): run-level progress (src/runProgress.js)
// and the run-time-spawned tasks the flow definition has no node for
// (src/runGraph.js). Both are pure over a run snapshot, so they test without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runProgress, formatElapsed, isTerminal } from '../src/runProgress.js';
import { spawnedTasks, taskNodeStatus, outputKey } from '../src/runGraph.js';

const T0 = '2026-07-16T12:00:00.000Z';
const at = ms => new Date(Date.parse(T0) + ms).toISOString();

const snap = ({ stage = 'execution', nodes = [], nodeStatus = {}, tasks = [], updatedAt } = {}) => ({
  meta: { runId: 'r1', stage, nodeStatus, createdAt: T0, ...(updatedAt ? { updatedAt } : {}) },
  flow: { id: 'f', name: 'F', nodes, edges: [] },
  tasks: { tasks },
  taskOutputs: {},
  nodeOutputs: {}
});
const node = (id, type, data = {}) => ({ id, type, position: { x: 0, y: 0 }, data });
const task = (id, status, extra = {}) => ({ id, status, title: `T ${id}`, worker: { provider: 'mock', model: 'm' }, ...extra });

// --- progress ---

test('progress counts node statuses against the live flow', () => {
  const p = runProgress(snap({
    nodes: [node('a', 'aiStep'), node('b', 'aiStep'), node('c', 'aiStep'), node('d', 'output')],
    nodeStatus: { a: 'done', b: 'active', c: 'failed' } // d has no entry yet
  }), Date.parse(T0));
  assert.equal(p.total, 4);
  assert.equal(p.done, 1);
  assert.equal(p.active, 1);
  assert.equal(p.failed, 1);
  assert.equal(p.live, true);
});

// The denominator has to come from flow.nodes, not the nodeStatus keys: a node
// materialized mid-run joins the flow before it ever gets a status entry, and
// counting keys would make the bar read 2/2 while three nodes still had to run.
test('progress counts nodes materialized mid-run that have no status yet', () => {
  const p = runProgress(snap({
    nodes: [node('plan', 'aiStep'), node('gen-1', 'aiStep'), node('gen-2', 'aiStep')],
    nodeStatus: { plan: 'done' }
  }), Date.parse(T0));
  assert.equal(p.total, 3);
  assert.equal(p.done, 1);
});

test('progress reports null without a snapshot or flow', () => {
  assert.equal(runProgress(null), null);
  assert.equal(runProgress({ meta: { stage: 'done' } }), null);
});

// Spawned tasks run INSIDE their owning node, so folding them into the node
// count would make the denominator grow mid-run and the bar jump backwards.
test('running tasks are reported separately, not folded into the node count', () => {
  const p = runProgress(snap({
    nodes: [node('w', 'agentTask', { taskId: 'task-1' })],
    nodeStatus: { w: 'active' },
    tasks: [task('task-1', 'running'), task('task-2', 'running'), task('task-3', 'done')]
  }), Date.parse(T0));
  assert.equal(p.total, 1);
  assert.equal(p.tasksRunning, 2);
});

test('a live run clocks to now; a finished run freezes at its last write', () => {
  const live = runProgress(snap({ nodes: [node('a', 'aiStep')] }), Date.parse(T0) + 5000);
  assert.equal(live.elapsedMs, 5000);

  const done = runProgress(
    snap({ stage: 'done', nodes: [node('a', 'aiStep')], updatedAt: at(9000) }),
    Date.parse(T0) + 60000 // long after the fact: the clock must not have kept running
  );
  assert.equal(done.live, false);
  assert.equal(done.elapsedMs, 9000);
});

test('isTerminal matches the runner stages', () => {
  for (const s of ['done', 'failed', 'rejected', 'stopped', 'interrupted']) assert.equal(isTerminal(s), true);
  for (const s of ['execution', 'awaiting_approval', 'planning']) assert.equal(isTerminal(s), false);
});

test('formatElapsed renders m:ss and h:mm:ss', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(9000), '0:09');
  assert.equal(formatElapsed(95000), '1:35');
  assert.equal(formatElapsed(3600000 + 125000), '1:02:05');
  assert.equal(formatElapsed(null), '');
});

// --- spawned tasks ---

test('a node-backed task is not spawned (it is already drawn as its node)', () => {
  const s = snap({
    nodes: [node('w', 'agentTask', { taskId: 'task-1' })],
    tasks: [task('task-1', 'running')]
  });
  assert.deepEqual(spawnedTasks(s), []);
});

test('a task created by an agent hangs off the node that owns its parent', () => {
  const s = snap({
    nodes: [node('w', 'agentTask', { taskId: 'task-1' })],
    tasks: [task('task-1', 'done'), task('task-2', 'running', { createdBy: 'task-1' })]
  });
  const out = spawnedTasks(s);
  assert.equal(out.length, 1);
  assert.equal(out[0].task.id, 'task-2');
  assert.equal(out[0].ownerNodeId, 'w');
});

test('ownership walks a chain of spawns back to the node', () => {
  const s = snap({
    nodes: [node('w', 'agentTask', { taskId: 'task-1' })],
    tasks: [
      task('task-1', 'done'),
      task('task-2', 'done', { createdBy: 'task-1' }),
      task('task-3', 'running', { createdBy: 'task-2' }) // grandchild
    ]
  });
  assert.deepEqual(spawnedTasks(s).map(o => [o.task.id, o.ownerNodeId]),
    [['task-2', 'w'], ['task-3', 'w']]);
});

// createdBy names a NODE, not a task, when the runner spawns on a node's behalf
// — stitch fix tasks pass the node id as ctx.taskId (postProcess in
// core/stackRunner.js). Both shapes have to resolve.
test('a stitch fix task, whose createdBy is a node id, resolves to that node', () => {
  const s = snap({
    nodes: [node('stitch-1', 'aiStep', { role: 'stitch' })],
    tasks: [task('task-1', 'pending', { createdBy: 'stitch-1' })]
  });
  assert.deepEqual(spawnedTasks(s).map(o => [o.task.id, o.ownerNodeId]), [['task-1', 'stitch-1']]);
});

// Untraceable work is still work: show it rather than silently dropping it.
test('an untraceable spawned task is returned with a null owner', () => {
  const s = snap({ nodes: [node('a', 'aiStep')], tasks: [task('task-9', 'running', { createdBy: 'agent' })] });
  assert.deepEqual(spawnedTasks(s), [{ task: s.tasks.tasks[0], ownerNodeId: null }]);
});

test('a createdBy cycle terminates instead of hanging the renderer', () => {
  const s = snap({
    nodes: [node('w', 'agentTask', { taskId: 'task-0' })],
    tasks: [task('task-1', 'running', { createdBy: 'task-2' }), task('task-2', 'running', { createdBy: 'task-1' })]
  });
  assert.deepEqual(spawnedTasks(s).map(o => o.ownerNodeId), [null, null]);
});

test('taskNodeStatus maps tasks.json statuses onto the canvas vocabulary', () => {
  assert.equal(taskNodeStatus('running'), 'active');
  assert.equal(taskNodeStatus('done'), 'done');
  assert.equal(taskNodeStatus('failed'), 'failed');
  assert.equal(taskNodeStatus('pending'), 'pending');
});

test('outputKey mirrors the store filename sanitizing', () => {
  assert.equal(outputKey('orch-1.plan'), 'orch-1_plan');
  assert.equal(outputKey('plain-id'), 'plain-id');
});
