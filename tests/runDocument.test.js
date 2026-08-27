// Plaintext mirror: the typeset dossier projected from a run snapshot
// (src/runDocument.js). Pure over the snapshot, so it tests without a DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDocument } from '../src/runDocument.js';

const snap = {
  meta: {
    runId: 'run-abc', stage: 'done', flowName: 'Default pipeline',
    createdAt: '2026-07-18T18:18:32.0Z', updatedAt: '2026-07-18T18:18:47.0Z',
    nodeStatus: { in: 'done', work: 'done', out: 'done' },
  },
  prompt: 'Write a greeting.\nsecond line',
  flow: { name: 'Default pipeline', nodes: [
    { id: 'in', type: 'input' },
    { id: 'work', type: 'agentTask', data: { taskId: 'task-1' } },
    { id: 'out', type: 'output' },
  ], edges: [] },
  tasks: { tasks: [{ id: 'task-1', title: 'Do the work', status: 'done', worker: { provider: 'mock', model: 'mock-large' } }] },
  retrospectives: { 'executor-task-1': { durationMs: 3893 } },
  nodeOutputs: { out: 'The greeting.' },
  taskOutputs: { 'task-1': '...' },
};

test('the dossier carries the run header, node table, tasks and footer', () => {
  const doc = runDocument(snap);
  assert.match(doc, /RUN DOSSIER/);
  assert.match(doc, /Run {2,}Write a greeting\./);      // first prompt line only
  assert.match(doc, /Id {2,}run-abc/);
  assert.match(doc, /Stage {2,}done · 3\/3 nodes done/);
  assert.match(doc, /Elapsed {2,}0:15/);
  // node row shows status, id, type, and the executor task's duration mapped in
  assert.match(doc, /work {2,}agentTask {2,}3\.9s/);
  // task table + worker
  assert.match(doc, /task-1 {2,}Do the work {2,}mock\/mock-large {2,}3\.9s/);
  // result + footer path
  assert.match(doc, /RESULT/);
  assert.match(doc, /The greeting\./);
  assert.match(doc, /runs\/run-abc$/);
});

test('is stable and matches for the same snapshot (a pure projection)', () => {
  assert.equal(runDocument(snap), runDocument(snap));
});

test('a failed run surfaces its error and omits sections it has no data for', () => {
  const doc = runDocument({
    meta: { runId: 'r2', stage: 'failed', error: 'boom', nodeStatus: {} },
    flow: { name: 'F', nodes: [{ id: 'a', type: 'input' }], edges: [] },
  });
  assert.match(doc, /Error {2,}boom/);
  assert.ok(!doc.includes('TASKS'), 'no TASKS section without tasks');
});

test('returns empty string when there is no run', () => {
  assert.equal(runDocument(null), '');
  assert.equal(runDocument({}), '');
});
