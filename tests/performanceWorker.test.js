import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlSessionStore, readSessionLogFile, repairInterruptedSessions } from '#kernel';
import { ReadWorkerClient } from '../core/readWorkerClient.js';
import { StoredStackSnapshotReader } from '../core/runProjection.js';
import { RunStore } from '../core/state.js';
import { seedPerformanceRuns } from '../scripts/performance-fixture.mjs';
import { measure } from '../scripts/performance-metrics.mjs';
import { fileFingerprint } from '../core/fileFingerprint.js';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-worker-test-'));
  const worker = new ReadWorkerClient();
  t.after(async () => {
    await worker.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('flyt-worker-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, worker, inspectSessions: (root, runIds) => worker.request('inspect', { root, runIds }) };
}

test('worker batches match existing summaries; projection and large logs are read-only', async t => {
  const { root, worker } = setup(t);
  const { ids, sessionBytes } = seedPerformanceRuns(root, 65, 2, { toolBytes: 10000 });
  const stamps = ids.map(id => ['meta.json', 'session.jsonl', 'prompt.md'].map(file => fileFingerprint(path.join(root, id, file))));
  const batches = [];
  const rows = await worker.request('summaries', { root }, { onBatch: batch => batches.push(batch.length) });
  assert.deepEqual(batches, [32, 32, 1]);
  assert.deepEqual(rows.reverse(), new RunStore(root).runSummaries());
  const { sample } = await measure('inspect', () => worker.request('inspect', { root }));
  assert.equal(sample.syncReadBytes, 0);
  assert(sample.workerReadBytes >= sessionBytes);
  const runId = ids[0];
  assert.deepEqual(await worker.request('log', { root, runId }), readSessionLogFile(path.join(root, runId, 'session.jsonl')).events);
  assert.deepEqual(await worker.request('snapshot', { root, runId }), await new StoredStackSnapshotReader().snapshot(root, runId, null, { materialise: false }));
  assert.deepEqual(ids.map(id => ['meta.json', 'session.jsonl', 'prompt.md'].map(file => fileFingerprint(path.join(root, id, file)))), stamps);
});

test('worker log cache invalidates same-size edits and replacement with preserved mtime', async t => {
  const { root, worker } = setup(t);
  const { ids: [runId] } = seedPerformanceRuns(root, 1, 1);
  const file = path.join(root, runId, 'session.jsonl');
  await worker.request('snapshot', { root, runId });
  const stat = fs.statSync(file), original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('"stage":"done"', '"stage":"work"'));
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal((await worker.request('snapshot', { root, runId })).meta.stage, 'work');
  fs.writeFileSync(`${file}.new`, original); fs.renameSync(`${file}.new`, file);
  assert.equal((await worker.request('snapshot', { root, runId })).meta.stage, 'done');
});

test('cancelling active and queued reads preserves other requests and allows restart', async t => {
  const { root, worker } = setup(t);
  seedPerformanceRuns(root, 100, 30);
  const active = new AbortController(), queued = new AbortController();
  let batches = 0;
  const first = worker.request('inspect', { root }, { signal: active.signal, onBatch: () => { batches++; active.abort(); } });
  const second = worker.request('summaries', { root }, { signal: queued.signal });
  const third = worker.request('summaries', { root });
  const rejected = [assert.rejects(first, { name: 'AbortError' }), assert.rejects(second, { name: 'AbortError' })];
  queued.abort();
  await Promise.all(rejected);
  assert.equal(batches, 1, 'no stale batches after cancellation');
  assert.equal((await third).length, 100);
  await assert.rejects(worker.request('invalid', { root }), /Unknown read operation/);
  assert.equal((await worker.request('summaries', { root })).length, 100);
  await assert.rejects(worker.request('log', { root, runId: '../escape' }), /Not a run/);
});

test('closing rejects pending work and prevents new reads', async t => {
  const { root, worker } = setup(t);
  seedPerformanceRuns(root, 1, 1);
  const pending = assert.rejects(worker.request('inspect', { root }), { name: 'AbortError' });
  await worker.close(); await pending;
  await assert.rejects(worker.request('summaries', { root }), /closed/);
});

test('worker exit rejects its active read and restarts for queued work', async t => {
  const worker = new ReadWorkerClient({ workerURL: new URL('./fixtures/readWorkerFailure.mjs', import.meta.url) });
  t.after(() => worker.close());
  const failed = assert.rejects(worker.request('crash', {}), /exited \(17\)/);
  const pending = worker.request('continue', {});
  await failed;
  assert.equal(await pending, 'restarted');
});

test('worker-assisted recovery reproduces canonical recovery, including torn tails', async t => {
  const { root, inspectSessions } = setup(t);
  const left = path.join(root, 'left'), right = path.join(root, 'right');
  seedPerformanceRuns(left, 1, 2);
  const file = path.join(left, 'perf-00000', 'session.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  fs.writeFileSync(file, lines.slice(0, -2).join('\n') + '\n{"torn":');
  fs.cpSync(left, right, { recursive: true });
  assert.deepEqual(await repairInterruptedSessions(left), await repairInterruptedSessions(right, { inspectSessions }));
  const events = dir => readSessionLogFile(path.join(dir, 'perf-00000', 'session.jsonl')).events.map(({ at, ...event }) => event);
  assert.deepEqual(events(left), events(right));
  assert.deepEqual(new RunStore(left).readMeta('perf-00000').blockStatus, new RunStore(right).readMeta('perf-00000').blockStatus);
});

test('changed terminal observations and denied claims never bypass controller validation', async t => {
  const { root, inspectSessions } = setup(t);
  const { ids: [runId] } = seedPerformanceRuns(root, 1, 1);
  const sessions = new JsonlSessionStore(root);
  let changed = false, claims = 0;
  const inspect = async (...args) => {
    const rows = await inspectSessions(...args);
    if (!changed) {
      changed = true;
      await (await sessions.open(runId)).append({ type: 'run.stage', data: { stage: 'execution' } });
    }
    return rows;
  };
  assert.deepEqual(await repairInterruptedSessions(root, { inspectSessions: inspect, claim: () => { claims++; return null; } }), []);
  assert.equal(claims, 1);
  assert.equal((await sessions.read(runId)).readSync().at(-1).data.stage, 'execution');
  fs.writeFileSync(path.join(root, runId, 'execution-owner.json'), JSON.stringify({ pid: process.pid, beatAt: Date.now() }));
  assert.deepEqual(await repairInterruptedSessions(root, { inspectSessions, claim: () => { throw new Error('live owner must not be claimed'); } }), []);
});
