// The container-expansion spine (DECISIONS.md D36). The orchestrator's own tests
// (orchestrator.test.js) prove the extraction end to end; these pin the seam
// itself, because the fan-out (P2) and sub-flow (P3) nodes are about to depend
// on exactly these edges — scoped dependencies, wave selection, status
// seeding, and a per-consumer child label.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readyChildren, containerWave, ensureChildStatuses, aggregateChildren
} from '../core/nodes/expand.js';

const ai = id => ({ id, type: 'aiStep', data: {} });
const task = id => ({ id, type: 'agentTask', data: {} });

// --- scoped dependencies ----------------------------------------------------

test('a child waits for siblings it depends on, and for nothing outside the box', () => {
  const children = [ai('a'), ai('b')];
  const ids = new Set(['a', 'b']);
  const edges = [
    { source: 'a', target: 'b' },        // inside the box: b waits for a
    { source: 'upstream', target: 'a' }  // the container's own inbound wiring
  ];
  assert.deepEqual(readyChildren(children, edges, new Set(), ids).map(c => c.id), ['a'],
    'an edge from outside the box says nothing about child order');
  assert.deepEqual(readyChildren(children, edges, new Set(['a']), ids).map(c => c.id), ['b']);
  assert.deepEqual(readyChildren(children, edges, new Set(['a', 'b']), ids), []);
});

test('a feedback edge never holds a child back', () => {
  // Feedback edges point backwards by design — they are a reverse channel
  // outside the execution order, and forwardEdges drops them.
  const children = [ai('a'), ai('b')];
  const ids = new Set(['a', 'b']);
  const edges = [{ source: 'b', target: 'a', sourceHandle: 'feedback' }];
  assert.deepEqual(readyChildren(children, edges, new Set(), ids).map(c => c.id), ['a', 'b']);
});

// --- wave selection ---------------------------------------------------------

test('wave-safe children batch up to the parallel bound; anything else runs alone', () => {
  const ready = [ai('a'), ai('b'), task('c'), ai('d')];
  assert.deepEqual(containerWave(ready, 4).map(c => c.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(containerWave(ready, 2).map(c => c.id), ['a', 'b'], 'bounded by maxParallel');
  assert.deepEqual(containerWave([ai('solo')], 4).map(c => c.id), ['solo']);
  // A single wave-safe child, or a child of any other type, takes the
  // one-at-a-time path.
  const odd = [{ id: 'weird', type: 'orchestrator', data: {} }, ai('x')];
  assert.deepEqual(containerWave(odd, 4).map(c => c.id), ['weird']);
});

// --- status seeding ---------------------------------------------------------

test('children that skipped the outer scheduler get a pending status, without clobbering', () => {
  let meta = { nodeStatus: { a: 'done' } };
  const store = { readMeta: () => meta, writeMeta: (_id, next) => { meta = next; } };
  ensureChildStatuses(store, 'run-1', [ai('a'), ai('b'), ai('c')]);
  assert.deepEqual(meta.nodeStatus, { a: 'done', b: 'pending', c: 'pending' });
});

test('nothing is written when every child already has a status', () => {
  const meta = { nodeStatus: { a: 'done' } };
  let writes = 0;
  const store = { readMeta: () => meta, writeMeta: () => { writes += 1; } };
  ensureChildStatuses(store, 'run-1', [ai('a')]);
  assert.equal(writes, 0, 'a no-op must not rewrite meta.json');
});

// --- aggregation ------------------------------------------------------------

test('aggregation reads node outputs, task outputs, and honours a custom label', () => {
  const runner = {
    store: {
      readNodeOutput: (_r, id) => (id === 'a' ? 'output A' : null),
      readTaskOutput: (_r, id) => (id === 'task-7' ? 'output T' : null)
    }
  };
  const children = [
    { id: 'a', type: 'aiStep', data: { title: 'Alpha' } },
    { id: 'b', type: 'agentTask', data: { taskId: 'task-7' } },
    { id: 'c', type: 'aiStep', data: {} }
  ];
  const sections = aggregateChildren(runner, 'run-1', { id: 'box' }, children);
  assert.match(sections[0], /^--- Alpha \(a\) ---\n\noutput A$/);
  assert.match(sections[1], /^--- b \(b\) ---\n\noutput T$/, 'an agentTask reads its task output');
  assert.match(sections[2], /\(no output\)$/, 'a child that produced nothing says so');

  const labelled = aggregateChildren(runner, 'run-1', { id: 'box' }, children, { label: c => `lane:${c.id}` });
  assert.match(labelled[0], /^--- lane:a \(a\) ---/, 'a fan-out lane can name its own children');
});

test('a live taskIdByNode mapping beats the id stored on the node', () => {
  const runner = { store: { readNodeOutput: () => null, readTaskOutput: (_r, id) => `from ${id}` } };
  const children = [{ id: 'b', type: 'agentTask', data: { taskId: 'stale' } }];
  const sections = aggregateChildren(runner, 'run-1', { id: 'box' }, children,
    { taskIdByNode: new Map([['b', 'task-live']]) });
  assert.match(sections[0], /from task-live/);
});
