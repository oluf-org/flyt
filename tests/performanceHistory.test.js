import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonlSessionStore, repairInterruptedSessions } from '#kernel';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { seedPerformanceRuns } from '../scripts/performance-fixture.mjs';
import { measure } from '../scripts/performance-metrics.mjs';
import { watchingFromRun } from '../src/v2/dailyWorkModel.js';
import { runView } from '../src/v2/runView.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
function temporary(t, beforeCleanup = async () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-perf-test-'));
  t.after(async () => {
    await beforeCleanup();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    assert(path.basename(dir).startsWith('flyt-perf-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function harness(t) {
  let engine;
  const dir = temporary(t, async () => {
    await engine.runController.shutdown();
    engine.telemetry.close();
  });
  engine = createEngine({ projectRoot: repo, dataRoot: path.join(dir, 'data'), userDataDir: path.join(dir, 'profile'), log: () => {}, warn: () => {} });
  const api = createApi(engine);
  const { project } = engine.registry.createAppdata('Performance test');
  return { engine, api, project, invoke: name => api.invoke(name, { projectId: project.id }) };
}

for (const [chunks, toolBytes] of [[0, 0], [2000, 0], [20, 2 * 1024 * 1024]]) {
  test(`unchanged API history reads no bodies (${chunks} chunks, ${toolBytes} tool bytes)`, async t => {
    const { project, invoke } = harness(t);
    const fixture = seedPerformanceRuns(project.store.rootDir, 3, chunks, { toolBytes });
    const cold = await measure('cold', () => invoke('run:list'));
    assert.equal(cold.sample.syncReadBytes, 0, 'cold session parsing belongs to the worker');
    assert(cold.sample.workerReadBytes >= fixture.sessionBytes);
    for (const name of ['history:activity', 'run:list', 'history:activity']) {
      const { value, sample } = await measure(name, () => invoke(name));
      assert.equal(value.length, 3);
      assert(value.every(row => row.stage === 'done'));
      assert.equal(sample.syncReadBytes, 0, 'completed session bodies must not be scanned again');
      assert.equal(sample.summaryReadCalls, 0, 'unchanged summary bodies must not be opened again');
      assert.equal(sample.workerReadBytes, 0);
      assert.equal(sample.workerSummaryReadCalls, 0);
    }
  });
}

test('new, resumed, removed and renamed history invalidates only changed records', async t => {
  const { project, invoke } = harness(t);
  const root = project.store.rootDir;
  const { ids } = seedPerformanceRuns(root, 2, 10);
  await invoke('history:activity');
  const session = await new JsonlSessionStore(root).open(ids[0]);
  await session.append({ type: 'run.stage', data: { stage: 'execution' } });
  await session.append({ type: 'block.status', data: { blockId: 'work', status: 'active' } });
  let rows = await invoke('history:activity');
  assert.equal(rows.find(r => r.id === ids[0]).stage, 'interrupted');
  assert.equal((await new JsonlSessionStore(root).read(ids[0])).readSync().at(-1).data.stage, 'interrupted');
  const added = await new JsonlSessionStore(root).open('external-new');
  await added.append({ type: 'run.created', data: { runId: 'external-new', prompt: 'New external run' } });
  await added.append({ type: 'run.stage', data: { stage: 'execution' } });
  rows = await invoke('run:list');
  assert.equal(rows.find(r => r.id === 'external-new').stage, 'interrupted');
  const metaFile = path.join(root, ids[1], 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, name: 'Externally renamed' }));
  assert.equal((await invoke('history:activity')).find(r => r.id === ids[1]).name, 'Externally renamed');
  project.store.deleteRun(ids[1]);
  assert.equal((await invoke('run:list')).length, 2);
});

test('same-size log edits with preserved mtime and replacement invalidate terminal hints', async t => {
  const root = temporary(t), cache = new Map();
  const { ids } = seedPerformanceRuns(root, 1, 0);
  const file = path.join(root, ids[0], 'session.jsonl');
  await repairInterruptedSessions(root, { terminalCache: cache });
  const stat = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
  const edited = text.replace('"stage":"done"', '"stage":"work"');
  assert.equal(edited.length, text.length);
  fs.writeFileSync(file, edited); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.deepEqual(await repairInterruptedSessions(root, { terminalCache: cache }), ids);
  await repairInterruptedSessions(root, { terminalCache: cache });
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, edited); fs.renameSync(replacement, file);
  assert.deepEqual(await repairInterruptedSessions(root, { terminalCache: cache }), ids);
});

test('live ownership and denied claims are rechecked before crash recovery', async t => {
  const root = temporary(t), cache = new Map();
  const session = await new JsonlSessionStore(root).open('owned');
  await session.append({ type: 'run.created', data: { runId: 'owned' } });
  await session.append({ type: 'run.stage', data: { stage: 'execution' } });
  const file = path.join(root, 'owned', 'execution-owner.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, beatAt: Date.now() }));
  assert.deepEqual(await repairInterruptedSessions(root, { terminalCache: cache }), []);
  fs.unlinkSync(file);
  assert.deepEqual(await repairInterruptedSessions(root, { terminalCache: cache, claim: () => null }), []);
  let releases = 0;
  assert.deepEqual(await repairInterruptedSessions(root, { terminalCache: cache, claim: () => () => releases++ }), ['owned']);
  assert.equal(releases, 1);
});

test('targeted reconciliation reads canonical evidence despite a warm history cache', async t => {
  const { engine, project, invoke } = harness(t);
  const { ids } = seedPerformanceRuns(project.store.rootDir, 2, 20);
  await invoke('history:activity');
  const { sample } = await measure('targeted', () => engine.runController.reconcile(project.id, ids[0]));
  assert(sample.workerReadBytes > 0);
  assert.equal(sample.syncReadCalls, 0);
  assert.equal(sample.workerReadBytes, fs.statSync(path.join(project.store.rootDir, ids[0], 'session.jsonl')).size, 'targeted validation reads only the requested session');
  const broad = engine.runController.reconcile(project.id);
  const targeted = await measure('overlapping targeted', () => engine.runController.reconcile(project.id, ids[0]));
  await broad;
  assert(targeted.sample.workerReadBytes > 0, 'an overlapping cached poll cannot replace targeted validation');
});

test('summary cache notices same-size metadata and prompt edits with preserved mtime', async t => {
  const { project, invoke } = harness(t);
  const { ids } = seedPerformanceRuns(project.store.rootDir, 1, 0);
  await invoke('history:activity');
  const dir = path.join(project.store.rootDir, ids[0]);
  const prompt = path.join(dir, 'prompt.md');
  const oldPrompt = fs.readFileSync(prompt, 'utf8'), oldStat = fs.statSync(prompt);
  const nextPrompt = oldPrompt.replace('Performance', 'Replacement');
  assert.equal(nextPrompt.length, oldPrompt.length);
  fs.writeFileSync(prompt, nextPrompt); fs.utimesSync(prompt, oldStat.atime, oldStat.mtime);
  assert.match((await invoke('history:activity'))[0].name, /Replacement/);
  const meta = path.join(dir, 'meta.json'), metaStat = fs.statSync(meta);
  const oldMeta = fs.readFileSync(meta, 'utf8');
  const newMeta = oldMeta.replace('"stage": "done"', '"stage": "stop"');
  assert.notEqual(oldMeta, newMeta);
  assert.equal(oldMeta.length, newMeta.length);
  fs.writeFileSync(meta, newMeta); fs.utimesSync(meta, metaStat.atime, metaStat.mtime);
  assert.equal((await invoke('run:list'))[0].stage, 'stop');
});

test('same run IDs in different projects do not share recovery or summary entries', async t => {
  const { engine, project, api, invoke } = harness(t);
  const second = engine.registry.createAppdata('Second project').project;
  seedPerformanceRuns(project.store.rootDir, 1, 1);
  seedPerformanceRuns(second.store.rootDir, 1, 1);
  await invoke('run:list');
  const { sample } = await measure('other project', () => api.invoke('run:list', { projectId: second.id }));
  assert(sample.workerReadBytes > 0);
  assert(sample.workerSummaryReadCalls > 0);
});

test('the performance fixture produces a real Work view with model and tool activity', async t => {
  const { project, api } = harness(t);
  const { ids } = seedPerformanceRuns(project.store.rootDir, 1, 10, { toolBytes: 100 });
  const args = { projectId: project.id, runId: ids[0] };
  const snapshot = await api.invoke('run:snapshot', args);
  const log = await api.invoke('run:log', args);
  const watching = watchingFromRun(ids[0], snapshot, log);
  assert.equal(watching.stack.root.kind, 'sequence');
  assert.equal(watching.stack.root.children[0].id, 'work');
  const activity = runView(watching.trace, snapshot).blocks.work.activity;
  assert(activity.some(row => row.kind === 'chat' && row.content === 'Fixture complete.'));
  assert(activity.some(row => row.kind === 'tool' && row.result.length === 100));
  const combined = await api.invoke('run:snapshot', { ...args, includeLog: true });
  assert.deepEqual(combined.log, log);
  assert.deepEqual(combined.snapshot, { ...snapshot, rev: snapshot.rev + 1 });
  assert.equal(combined.snapshot.session.head, combined.log.at(-1).seq);
});

test('project switching cancels obsolete reads without publishing stale snapshot state', async t => {
  const { engine, project, api } = harness(t);
  const second = engine.registry.createAppdata('Replacement project').project;
  const { ids: [runId] } = seedPerformanceRuns(project.store.rootDir, 2, 2000);
  seedPerformanceRuns(second.store.rootDir, 1, 0);
  const args = { projectId: project.id, runId };
  const log = assert.rejects(api.invoke('run:log', args), { name: 'AbortError' });
  const snapshot = assert.rejects(api.invoke('run:snapshot', { ...args, includeLog: true }), { name: 'AbortError' });
  const executionValidation = engine.runController.reconcile(project.id, runId);
  api.activateReads(second.id);
  const rows = await api.invoke('run:list', { projectId: second.id });
  await Promise.all([log, snapshot, executionValidation]);
  assert.equal(rows.length, 1);
  assert.equal(engine.pushStateFor(project.id).channels.has(runId), false);
  assert.equal((await api.invoke('run:snapshot', args)).meta.stage, 'done', 'switching back starts fresh reads');
});
