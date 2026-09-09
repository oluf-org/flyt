import test from 'node:test';
import assert from 'node:assert/strict';
import { createBuildHistoryReader } from '../src/v2/buildHistory.js';
test('Build history skips hidden reads, shares cached reads and refreshes changed/live/expired rows', async () => {
  let calls = 0, time = 0;
  const reader = createBuildHistoryReader(async (project, ids) => { calls++; return ids.map(id => ({ project, id })); }, { now: () => time });
  const args = { projectId: 'one', workflowId: 'flow', visible: false, runs: [{ id: 'run', stackId: 'flow', stage: 'done' }] };
  assert.deepEqual(await reader.read(args), []);
  assert.equal(calls, 0);
  args.visible = true;
  const first = await reader.read(args);
  assert.deepEqual(await reader.read({ ...args, runs: structuredClone(args.runs) }), first);
  assert.equal(calls, 1);
  args.runs[0].updatedAt = 'changed';
  await reader.read(args); assert.equal(calls, 2);
  time = 5001;
  await reader.read(args); assert.equal(calls, 3);
  args.runs[0].stage = 'execution';
  await reader.read(args); await reader.read(args); assert.equal(calls, 5);
  await reader.read({ ...args, projectId: 'two' }); assert.equal(calls, 6);
});
test('failed Build history reads are retryable and selection is bounded', async () => {
  let calls = 0;
  const reader = createBuildHistoryReader(async (_project, ids) => { if (++calls === 1) throw new Error('offline'); return ids; });
  const args = { projectId: 'p', workflowId: 'f', visible: true, runs: Array.from({ length: 20 }, (_, i) => ({ id: `${i}`, stackId: i % 2 ? 'other' : 'f', stage: 'done' })) };
  await assert.rejects(reader.read(args), /offline/);
  assert.equal((await reader.read(args)).length, 10);
});
