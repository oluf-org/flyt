// Incremental IPC (V1 task 5): the diff/merge pair must be a faithful codec —
// applying a patch reproduces the target snapshot — and must converge even when
// applied to an intermediate state (the property that makes coalesced pushes and
// mid-run view switches safe).
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshot, mergeSnapshot } from '../core/snapshotDiff.js';

const snap = (over = {}) => ({
  meta: { runId: 'r1', stage: 'execution', nodeStatus: { a: 'pending' } },
  prompt: 'do the thing',
  plan: null,
  tasks: null,
  flow: { id: 'f', nodes: [], edges: [] },
  retrospectives: {},
  taskOutputs: {},
  nodeOutputs: {},
  ...over
});

test('no change yields a null patch', () => {
  const s = snap();
  assert.equal(diffSnapshot(s, structuredClone(s)), null);
});

test('a streaming node output only ships that node', () => {
  const a = snap({ nodeOutputs: { a: 'hello' } });
  const b = snap({ nodeOutputs: { a: 'hello world' } });
  const patch = diffSnapshot(a, b);
  assert.deepEqual(patch, { nodeOutputs: { set: { a: 'hello world' }, del: [] } });
  // Untouched fields are absent from the patch entirely.
  assert.ok(!('meta' in patch) && !('flow' in patch) && !('prompt' in patch));
  assert.deepEqual(mergeSnapshot(a, patch), b);
});

test('whole-value fields replace; map removals delete', () => {
  const a = snap({ nodeOutputs: { a: 'x', b: 'y' }, plan: 'p1' });
  const b = snap({ nodeOutputs: { a: 'x' }, plan: 'p2', meta: { runId: 'r1', stage: 'done' } });
  const patch = diffSnapshot(a, b);
  assert.deepEqual(patch.nodeOutputs, { set: {}, del: ['b'] });
  assert.equal(patch.plan, 'p2');
  assert.deepEqual(patch.meta, b.meta);
  assert.deepEqual(mergeSnapshot(a, patch), b);
});

test('merge returns a fresh reference (drives React re-render)', () => {
  const a = snap();
  const b = snap({ meta: { runId: 'r1', stage: 'done' } });
  const merged = mergeSnapshot(a, diffSnapshot(a, b));
  assert.notEqual(merged, a);
  assert.notEqual(merged.meta, a.meta);
});

test('a patch converges from an intermediate state whose drift it overwrites', () => {
  // Baseline the main process last sent, and two further mutations.
  const s0 = snap({ nodeOutputs: { a: 'v0' } });
  const s1 = snap({ nodeOutputs: { a: 'v1', b: 'new' }, meta: { runId: 'r1', stage: 'execution' } });
  const s2 = snap({ nodeOutputs: { a: 'v2', b: 'new' }, meta: { runId: 'r1', stage: 'done' } });
  // Every field where s1 differs from s2 also differs between s0 and s2, so the
  // patch carries all of them and overwrites the drift. This is the FRIENDLY
  // case — see the next test for why it does not generalize.
  const patch = diffSnapshot(s0, s2);
  assert.deepEqual(mergeSnapshot(s1, patch), s2);
});

// The bound on the property above, and the reason a rev must name exactly one
// snapshot on each side (see the run:snapshot handler in electron/main.js).
// A value that changes and changes BACK between baseline and current is not in
// the patch at all — the diff is null, so nothing is even pushed — and a
// receiver holding the intermediate value is stranded there. Reachable for real:
// a step-eval retry requeues an agentTask running -> pending -> running, and the
// canvas reads task.status === 'running' to show a task as active.
test('a patch does NOT repair an intermediate state it never diffed against (A-B-A)', () => {
  const running = { tasks: [{ id: 'task-1', status: 'running' }] };
  const pending = { tasks: [{ id: 'task-1', status: 'pending' }] };
  const s0 = snap({ tasks: running });  // main's baseline
  const s1 = snap({ tasks: pending });  // an intermediate a receiver might hold
  const s2 = snap({ tasks: running });  // current: back to where s0 was

  assert.equal(diffSnapshot(s0, s2), null, 'baseline and current match, so there is nothing to send');
  // Stranded: the receiver keeps 'pending' while the task is really running.
  assert.deepEqual(mergeSnapshot(s1, diffSnapshot(s0, s2)), s1);
  assert.notDeepEqual(mergeSnapshot(s1, diffSnapshot(s0, s2)), s2);
});
