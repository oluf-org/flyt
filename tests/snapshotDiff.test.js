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

test('a patch converges when applied to an intermediate state', () => {
  // Baseline the main process last sent, and two further mutations.
  const s0 = snap({ nodeOutputs: { a: 'v0' } });
  const s1 = snap({ nodeOutputs: { a: 'v1', b: 'new' }, meta: { runId: 'r1', stage: 'execution' } });
  const s2 = snap({ nodeOutputs: { a: 'v2', b: 'new' }, meta: { runId: 'r1', stage: 'done' } });
  // The renderer fetched a fresher state (s1) than the main baseline (s0); the
  // next push diffs s2 against s0. Applying s0->s2 onto s1 must still land on s2.
  const patch = diffSnapshot(s0, s2);
  assert.deepEqual(mergeSnapshot(s1, patch), s2);
});
