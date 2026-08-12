// The command surface and its HTTP front door (LOOP-PLAN §4.2, §13).
//
// The point of these is that the CLI, the server and the renderer reach ONE
// implementation. So they exercise the map directly, then over HTTP, and assert
// the auth posture — a local API that can run shell commands in a repo needs a
// real answer to "who is calling", not "it's only localhost".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';
import { createServer } from '../core/server.js';
import { waitFor } from './helpers.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-api-'));

function makeApi(opts = {}) {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot, ...opts });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  return { engine, api: createApi(engine), dataRoot };
}

test('every command is reachable by name, and a typo says so', async () => {
  const { api } = makeApi();
  assert.ok(api.names().includes('flow:run'));
  assert.ok((await api.invoke('flow:list')).length > 0);
  await assert.rejects(() => api.invoke('flow:runn'), err =>
    err instanceof ApiError && err.status === 404 && /Unknown command/.test(err.message));
});

test('an unopened project is a caller error, not a crash', async () => {
  const { api } = makeApi();
  await assert.rejects(() => api.invoke('run:list', { projectId: '/nope' }), err =>
    err instanceof ApiError && err.status === 404 && err.code === 'no_project');
});

test('a run can be started and gated entirely through the map', async () => {
  const { api, engine, dataRoot } = makeApi();
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { id: projectId } = await api.invoke('project:open', { folder: workspace });

  const runId = await api.invoke('flow:run', {
    projectId, flowId: 'default-pipeline', userInput: 'via the map', approvalMode: 'always'
  });
  assert.ok(runId);

  // Liveness is process state, which is exactly what the supervisor's heartbeat
  // needs and what a file cannot tell you after a crash.
  const live = await api.invoke('run:live', { projectId });
  assert.ok(Array.isArray(live[projectId]));

  const { store } = engine.registry.get(projectId);
  for (let i = 0; i < 6; i++) {
    const stage = await waitFor(
      () => ['done', 'failed', 'awaiting_approval'].find(s => store.readMeta(runId)?.stage === s),
      { label: 'settle', timeoutMs: 60000 });
    if (stage !== 'awaiting_approval') { assert.equal(stage, 'done'); break; }
    await api.invoke('run:approve', { projectId, runId });
    await waitFor(() => store.readMeta(runId)?.stage !== 'awaiting_approval', { label: 'gate clear', timeoutMs: 20000 });
  }

  const snap = await api.invoke('run:snapshot', { projectId, runId });
  assert.equal(snap.meta.stage, 'done');
  assert.ok(snap.rev >= 1, 'a snapshot re-baselines the diff channel');
});

// --- HTTP ------------------------------------------------------------------

async function withServer(fn, { token = 'test-token' } = {}) {
  let server = null;
  const { api, engine, dataRoot } = makeApi({
    emit: (type, payload) => server?.emit(type, payload),
    canEmit: () => Boolean(server?.hasClients())
  });
  server = createServer({ api, token });
  const { port } = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = (name, args = {}, headers = {}) => fetch(`${base}/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(args)
  });
  try { await fn({ base, call, api, engine, dataRoot, token }); }
  finally { await server.close(); }
}

test('health is open; everything else needs the token', async () => {
  await withServer(async ({ base, call }) => {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    // ...and says nothing about what is inside.
    const body = await health.json();
    assert.deepEqual(Object.keys(body).sort(), ['ok', 'service']);

    const noAuth = await fetch(`${base}/api/flow:list`, { method: 'POST' });
    assert.equal(noAuth.status, 401);

    const wrong = await call('flow:list', {}, { authorization: 'Bearer wrong-token' });
    assert.equal(wrong.status, 401);
    // A token of a different LENGTH must be rejected as cleanly as a wrong one
    // — the constant-time compare has to handle it rather than throw.
    const shorter = await call('flow:list', {}, { authorization: 'Bearer x' });
    assert.equal(shorter.status, 401);

    const ok = await call('flow:list');
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).result.length > 0);
  });
});

test('a command error crosses HTTP with its status, not as a 500', async () => {
  await withServer(async ({ call }) => {
    const unknown = await call('flow:nope');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).code, 'unknown_command');

    const noProject = await call('run:list', { projectId: '/nope' });
    assert.equal(noProject.status, 404);
    assert.equal((await noProject.json()).code, 'no_project');
  });
});

test('the event stream carries engine events to an attached client', async () => {
  await withServer(async ({ base, call, api, dataRoot, token }) => {
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctl.signal
    });
    assert.equal(res.status, 200);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // Read in the background; the run below is what produces the frames.
    const pump = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          seen += decoder.decode(value, { stream: true });
        }
      } catch { /* aborted at the end of the test */ }
    })();

    const workspace = path.join(dataRoot, 'work');
    fs.mkdirSync(workspace, { recursive: true });
    const { id: projectId } = await api.invoke('project:open', { folder: workspace });
    await call('flow:run', { projectId, flowId: 'default-pipeline', userInput: 'stream me', approvalMode: 'always' });

    await waitFor(() => (seen.includes('event: run:update') ? true : null),
      { label: 'a run:update frame', timeoutMs: 30000 });
    assert.match(seen, /event: run:update\ndata: \{/);

    ctl.abort();
    await pump;
  });
});
