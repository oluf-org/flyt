// The engine assembles and runs with no Electron (DESIGN-SPEC.md §8).
//
// This is the day-1 claim in test form: everything the app IS can be stood up
// from a plain node process, so a headless supervisor, a CLI and the desktop
// window are three front doors onto one implementation rather than three
// implementations. If this file needs `electron` to pass, the seam has leaked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySearchProviderKeys, createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { waitFor } from './helpers.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-engine-'));

async function settleRun(api, projectId, runId) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    // Active runs may append during a snapshot read; retry the explicit
    // resynchronization signal while retaining the overall deadline.
    const snapshot = await api.invoke('run:snapshot', { projectId, runId }).catch(error => {
      if (error.code === 'session_read_changed') return null;
      throw error;
    });
    const stage = snapshot?.meta?.stage;
    if (['done', 'failed'].includes(stage)) return stage;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for canonical run to settle');
}

// A fresh data root every time: the engine seeds flows/nodes/tools into it, so
// a test must never be able to touch the developer's real ones.
function makeEngine(opts = {}) {
  const dataRoot = tmp();
  return {
    dataRoot,
    engine: createEngine({ projectRoot, dataRoot, userDataDir: dataRoot, ...opts })
  };
}

test('the engine assembles from paths alone', () => {
  const { engine, dataRoot } = makeEngine();
  // Seeded stores: the shipped pipelines, the node library, the tool library.
  assert.ok(engine.flows.list().length > 0, 'flows seeded');
  assert.ok(engine.nodeLibrary.listFull().length > 0, 'node templates seeded');
  assert.ok(engine.toolLibrary.list().length > 0, 'tools seeded');
  // Settings were created and sealed under the given userData dir, not the repo.
  assert.ok(fs.existsSync(path.join(dataRoot, 'settings.json')));
  // Fresh installs fail closed until an authenticated model is chosen; the
  // test-only mock adapter is never a shipped default worker.
  assert.deepEqual(engine.runtimeConfig.workers.executor, { provider: null, model: null });
});

test('settings changes rebuild the runtime config in place', () => {
  const { engine } = makeEngine();
  const before = engine.runtimeConfig; // the runner holds THIS reference
  engine.settings.approvalMode = 'always';
  engine.rebuildRuntimeConfig();
  assert.equal(engine.runtimeConfig, before, 'rebuilt in place, not replaced');
  assert.equal(engine.runtimeConfig.approvalMode, 'always');
});

test('publicSettings never leaks a key', () => {
  const { engine } = makeEngine();
  engine.settings.providers = { openrouter: { apiKey: 'sk-secret-value' } };
  engine.rebuildRuntimeConfig();
  const pub = engine.publicSettings();
  assert.equal(pub.providers.openrouter.hasKey, true);
  assert.ok(!JSON.stringify(pub).includes('sk-secret-value'), 'the key itself stays inside');
});

test('search-provider keys are one-way, secret, durable, and available to web tools', () => {
  const { engine, dataRoot } = makeEngine();
  assert.equal(applySearchProviderKeys(engine.settings, {
    brave: '  brave-secret  ', tavily: 'tavily-secret',
  }), true);
  engine.rebuildRuntimeConfig();

  assert.equal(engine.runtimeConfig.providerKeys.brave, 'brave-secret');
  assert.equal(engine.runtimeConfig.providerKeys.tavily, 'tavily-secret');
  assert.deepEqual(engine.publicSettings().searchProviders, {
    brave: { hasKey: true }, tavily: { hasKey: true },
  });
  assert.ok(!JSON.stringify(engine.publicSettings()).includes('brave-secret'));
  assert.ok(!JSON.stringify(engine.publicSettings()).includes('tavily-secret'));

  assert.equal(applySearchProviderKeys(engine.settings, { brave: '', openrouter: 'not-search' }), false,
    'empty and unrelated settings patches cannot clear or replace a search key');
  engine.settings.approvalMode = 'always';
  engine.rebuildRuntimeConfig();
  assert.equal(engine.runtimeConfig.providerKeys.brave, 'brave-secret');
  assert.equal(engine.persistSettings(), true);

  const reopened = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  assert.equal(reopened.runtimeConfig.providerKeys.brave, 'brave-secret');
  assert.equal(reopened.runtimeConfig.providerKeys.tavily, 'tavily-secret');
  assert.equal(reopened.publicSettings().searchProviders.brave.hasKey, true);
  assert.ok(!JSON.stringify(reopened.publicSettings()).includes('brave-secret'));
});

test('fresh engine startup seeds a familiar daily prompt, not a Loop projection', () => {
  const { engine } = makeEngine();
  assert.deepEqual(engine.flows.list(), [
    { id: 'assistant', name: 'Assistant' },
  ]);
});

test('a canonical workflow runs end to end headlessly and emits the UI events', async () => {
  const events = [];
  const { engine, dataRoot } = makeEngine({ emit: (type, payload) => events.push({ type, payload }) });

  // Mock provider: no key, no network — the point here is the wiring, not the model.
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  const api = createApi(engine);

  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { project } = engine.registry.open(workspace);
  const { runId } = await api.invoke('workflow:run', {
    projectId: project.id, workflowId: 'research', input: 'headless smoke', approvalMode: 'always',
  });
  assert.ok(runId);
  assert.equal(await settleRun(api, project.id, runId), 'done');

  // Canonical runs push their durable event delta. Consumers fold it directly
  // and use run:snapshot only for an explicit initial read or gap repair.
  await waitFor(() => events.some(e => e.type === 'run:update'), { label: 'a run:update', timeoutMs: 5000 });
  const updates = events.filter(e => e.type === 'run:update' && e.payload.runId === runId);
  assert.ok(updates[0].payload.events?.length, 'the first push carries canonical events');
  assert.equal(updates[0].payload.full, undefined, 'no duplicate snapshot projection is pushed');
  assert.ok(events.some(e => e.type === 'project:activity'), 'live-run activity was broadcast');
});

test('shouldPush gates the expensive half without silencing activity', async () => {
  const events = [];
  const { engine, dataRoot } = makeEngine({
    emit: (type, payload) => events.push({ type, payload }),
    shouldPush: () => false // stand in for "this tab is in the background"
  });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  const api = createApi(engine);

  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { project } = engine.registry.open(workspace);
  const { runId } = await api.invoke('workflow:run', {
    projectId: project.id, workflowId: 'research', input: 'background', approvalMode: 'always',
  });
  assert.equal(await settleRun(api, project.id, runId), 'done');
  assert.ok(!events.some(e => e.type === 'run:update'), 'no snapshot/diff work was done for nobody');
  assert.ok(events.some(e => e.type === 'project:activity'), 'but the live indicator still got the truth');
});

test('async snapshot pushes serialize a dirty trailing read and keep revisions ordered', async () => {
  const events = [];
  const { engine, dataRoot } = makeEngine({ emit: (type, payload) => events.push({ type, payload }) });
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { project } = engine.registry.open(workspace);

  let version = 1;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const snapshot = value => ({ meta: { stage: value }, nodeOutputs: {}, taskOutputs: {}, retrospectives: {} });
  const push = engine.pushSnapshotFor(project.id, async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    const captured = version;
    if (calls === 1) await firstHeld;
    active -= 1;
    return snapshot(captured);
  });

  push('ordered-run');
  await waitFor(() => calls === 1, { label: 'first snapshot read to start' });
  version = 2;
  push('ordered-run');
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(calls, 1, 'a notification during an async read cannot start a competing read');
  releaseFirst();

  await waitFor(() => events.filter(e => e.type === 'run:update').length === 2,
    { label: 'serialized full and patch updates' });
  const updates = events.filter(e => e.type === 'run:update');
  assert.equal(maxActive, 1);
  assert.equal(updates[0].payload.full.meta.stage, 1);
  assert.equal(updates[1].payload.patch.meta.stage, 2);
  assert.deepEqual(updates.map(e => [e.payload.base, e.payload.rev]), [[null, 1], [1, 2]]);
});

test('a transient async snapshot failure retries without another notification', async () => {
  const events = [];
  const { engine, dataRoot } = makeEngine({ emit: (type, payload) => events.push({ type, payload }) });
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { project } = engine.registry.open(workspace);
  let calls = 0;
  const push = engine.pushSnapshotFor(project.id, async () => {
    calls += 1;
    if (calls === 1) throw new Error('transient read failure');
    return { meta: { stage: 'done' }, nodeOutputs: {}, taskOutputs: {}, retrospectives: {} };
  });

  push('retry-run');
  const update = await waitFor(() => events.find(e => e.type === 'run:update'),
    { label: 'snapshot retry update' });
  assert.equal(calls, 2);
  assert.equal(update.payload.full.meta.stage, 'done');
});

test('canonical run events are coalesced and do no snapshot work', async () => {
  const events = [];
  const { engine, dataRoot } = makeEngine({ emit: (type, payload) => events.push({ type, payload }) });
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { project } = engine.registry.open(workspace);
  const push = engine.pushEventsFor(project.id);
  push('kernel-run', { seq: 1, type: 'turn.start', data: {} });
  push('kernel-run', { seq: 2, type: 'llm.stream', data: { text: 'a' } });
  push('kernel-run', { seq: 3, type: 'llm.stream', data: { text: 'b' } });

  const update = await waitFor(() => events.find(event => event.type === 'run:update'), {
    label: 'coalesced canonical events',
  });
  assert.deepEqual(update.payload.events.map(event => event.seq), [1, 2, 3]);
  assert.equal(update.payload.full, undefined);
  assert.equal(update.payload.patch, undefined);
  assert.equal(engine.pushStateFor(project.id).pending.size, 0);
});
