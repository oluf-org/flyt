// Replay: folding a run's log into ordered status frames (src/runReplay.js).
// Pure over the log + flow, so it tests without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { foldReplay, replaySnapshot } from '../src/runReplay.js';

const flow = { nodes: [
  { id: 'in', type: 'input' },
  { id: 'a', type: 'agentTask', data: { taskId: 'task-1' } },
  { id: 'b', type: 'agentTask', data: { taskId: 'task-2' } },
  { id: 'out', type: 'output' },
], edges: [] };

// a + b are independent → one parallel wave (both active at once)
const log = [
  { ts: '2026-01-01T00:00:00.000Z', event: 'node_start', node: 'in' },
  { ts: '2026-01-01T00:00:00.100Z', event: 'node_start', node: 'a' },
  { ts: '2026-01-01T00:00:00.110Z', event: 'node_start', node: 'executor:task-1' },
  { ts: '2026-01-01T00:00:00.120Z', event: 'node_start', node: 'b' },
  { ts: '2026-01-01T00:00:00.130Z', event: 'node_start', node: 'executor:task-2' },
  { ts: '2026-01-01T00:00:01.000Z', event: 'retrospective', node: 'executor-task-1' },
  { ts: '2026-01-01T00:00:01.500Z', event: 'retrospective', node: 'executor-task-2' },
  { ts: '2026-01-01T00:00:01.600Z', event: 'node_start', node: 'out' },
];

test('input/output nodes are done at start (they log no retrospective)', () => {
  const frames = foldReplay(log, flow);
  assert.equal(frames[0].line, 'in done');
  assert.equal(frames[0].nodeStatus.in, 'done');
  assert.equal(frames.at(-1).nodeStatus.out, 'done');
});

test('a parallel wave shows both work nodes active at once', () => {
  const frames = foldReplay(log, flow);
  // after b starts (before either retrospective) both a and b are active
  const wave = frames.find(f => f.line === 'b started');
  assert.equal(wave.nodeStatus.a, 'active');
  assert.equal(wave.nodeStatus.b, 'active');
  assert.equal(wave.taskStatus['task-1'], 'running');
});

test('a task retrospective completes its owning node', () => {
  const frames = foldReplay(log, flow);
  const afterT1 = frames.find(f => f.line === 'task-1 done');
  assert.equal(afterT1.nodeStatus.a, 'done');
  assert.equal(afterT1.taskStatus['task-1'], 'done');
  assert.equal(afterT1.nodeStatus.b, 'active', 'b still running while a finishes');
});

test('frames are time-ordered and end all-done', () => {
  const frames = foldReplay(log, flow);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i].t >= frames[i - 1].t);
  const last = frames.at(-1).nodeStatus;
  assert.deepEqual(last, { in: 'done', a: 'done', b: 'done', out: 'done' });
});

test('replaySnapshot overlays a frame onto the snapshot, status only', () => {
  const snap = {
    meta: { runId: 'r', stage: 'done', nodeStatus: { in: 'done', a: 'done', b: 'done', out: 'done' } },
    flow, tasks: { tasks: [{ id: 'task-1', status: 'done', title: 'T1' }, { id: 'task-2', status: 'done', title: 'T2' }] },
  };
  const frame = foldReplay(log, flow).find(f => f.line === 'task-1 done');
  const rs = replaySnapshot(snap, frame);
  assert.equal(rs.meta.nodeStatus.b, 'active');           // time-traveled
  assert.equal(rs.tasks.tasks.find(t => t.id === 'task-2').status, 'running');
  assert.equal(rs.flow, snap.flow);                        // untouched
  assert.equal(snap.meta.nodeStatus.b, 'done');            // original not mutated
});

test('empty / missing log yields no frames', () => {
  assert.deepEqual(foldReplay([], flow), []);
  assert.deepEqual(foldReplay(null, flow), []);
});
