// The command surface and its HTTP front door (DESIGN-SPEC.md §8).
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
import { createApi, ApiError, loopLaunchModels, loopWorkerProblem } from '../core/api.js';
import { createServer } from '../core/server.js';
import { waitFor } from './helpers.js';
import { git } from '../core/worktree.js';
import { scoreSuite, saveCard } from '../core/benchmark.js';
import { dateStamp } from '../core/archive.js';

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

test('an explicit Loop model clears the saved band map before any task is claimed', () => {
  const saved = { low: 'cheap', high: 'strong' };

  assert.deepEqual(loopLaunchModels({
    worker: { provider: 'auto', model: 'chosen-for-this-session' },
    configuredModels: saved,
  }), {}, 'the explicit worker must not be shadowed by settings');

  assert.deepEqual(loopLaunchModels({
    worker: { provider: 'auto', model: 'single' },
    models: { medium: 'explicit-band' },
    configuredModels: saved,
  }), { medium: 'explicit-band' }, 'an explicit band map remains the most specific choice');

  assert.deepEqual(loopLaunchModels({ configuredModels: saved }), saved,
    'without a launch override the saved map still applies');
});

test('a sandboxed delegated agent is refused as a Loop worker before it can claim work', () => {
  assert.match(loopWorkerProblem({ provider: 'codex', model: 'gpt-5.6-sol' }),
    /cannot work a Loop task.*file and shell tools/);
  assert.equal(loopWorkerProblem({ provider: 'openrouter', model: 'tool-model' }), null);
  assert.equal(loopWorkerProblem({ provider: 'codex', model: 'gpt-5.6-sol', reviewer: true }),
    loopWorkerProblem({ provider: 'codex', model: 'gpt-5.6-sol' }),
    'the helper describes worker capability; reviewers do not call it');
});

test('Loop preflights a subscription reviewer before claiming and accepts a supported override', async () => {
  const probes = [];
  const { api, engine, dataRoot } = makeApi({
    capabilityProbe: async ({ provider, model }) => {
      probes.push([provider, model]);
      return model === 'gpt-5.2-codex'
        ? { status: 'unsupported' }
        : { status: 'usable', ok: true };
    }
  });
  engine.hasKey = id => id === 'codex' || id === 'mock';
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { id: projectId } = await api.invoke('project:open', { folder: workspace });
  const task = await api.invoke('task:add', { projectId, title: 'must stay queued', goal: 'g' });

  await assert.rejects(api.invoke('loop:start', {
    projectId,
    worker: { provider: 'mock', model: 'mock-large' },
    reviewer: { provider: 'codex', model: 'gpt-5.2-codex' },
    only: [task.id]
  }), error => error.code === 'model_unsupported' && /reviewer.*gpt-5\.2-codex/.test(error.message));
  assert.equal((await api.invoke('task:get', { projectId, id: task.id })).status, 'queued',
    'capability refusal happens before Supervisor can claim work');

  const started = await api.invoke('loop:start', {
    projectId,
    worker: { provider: 'mock', model: 'mock-large' },
    reviewer: { provider: 'codex', model: 'gpt-5.6-sol' },
    only: ['t-not-present']
  });
  assert.equal(started.started, true);
  assert.equal(started.reviewer, 'gpt-5.6-sol');
  assert.deepEqual(probes, [
    ['codex', 'gpt-5.2-codex'], ['codex', 'gpt-5.6-sol']
  ]);
});

test('doctor returns connected and usable states through the capability probe', async () => {
  const { api, engine } = makeApi({
    capabilityProbe: async ({ model }) => model === 'gpt-5.2-codex'
      ? { status: 'unsupported' }
      : { status: 'usable', ok: true }
  });
  engine.hasKey = id => id === 'codex' || id === 'mock';
  engine.resolveModelSource = model => ({ provider: 'codex', model });
  engine.settings.activeModels = [];

  const report = await api.invoke('diag:doctor', {
    models: ['gpt-5.2-codex', 'gpt-5.6-sol']
  });
  assert.deepEqual(report.selected.map(item => [item.model, item.connected, item.usable, item.capability]), [
    ['gpt-5.2-codex', true, false, 'unsupported'],
    ['gpt-5.6-sol', true, true, 'usable']
  ]);
  assert.ok(report.findings.some(item => /gpt-5\.2-codex.*account rejects/.test(item.message)));
});

test('a loop running in another process is visible here — and a dead one is not believed', async () => {
  // The status file outlives the process that wrote it. A reader that trusts it
  // blindly reports work in flight that stopped hours ago, which is worse than
  // reporting nothing: the panel that exists to answer "is it stuck" would be
  // answering "it is fine" about a process that no longer exists.
  const { api, dataRoot } = makeApi();
  const workspace = path.join(dataRoot, 'work');
  fs.mkdirSync(workspace, { recursive: true });
  const { id: projectId } = await api.invoke('project:open', { folder: workspace });

  const file = path.join(workspace, '.flyt', 'loop-status.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    running: true, stopping: null, inFlight: [{ taskId: 't-0001', ageMs: 1000, idleMs: 10 }],
    parked: [], completed: 2, landed: 1, models: { low: 'a', high: 'b' }
  };

  // A live writer is believed, and marked as observed rather than owned.
  fs.writeFileSync(file, JSON.stringify({ ...record, pid: process.pid, at: new Date().toISOString() }));
  const live = await api.invoke('loop:status', { projectId });
  assert.equal(live.running, true);
  assert.equal(live.observed, true);
  assert.equal(live.inFlight.length, 1);
  assert.deepEqual(live.models, { low: 'a', high: 'b' });
  // The report says where its numbers came from, in words.
  assert.match(await api.invoke('loop:report', { projectId }), /observed: pid \d+/);

  // A pid that is gone is reported as stopped, with the reason, not as running.
  fs.writeFileSync(file, JSON.stringify({ ...record, pid: 999999, at: new Date().toISOString() }));
  const dead = await api.invoke('loop:status', { projectId });
  assert.equal(dead.running, false);
  assert.equal(dead.stale, true);
  assert.deepEqual(dead.inFlight, []);
  assert.match(dead.stopping, /pid 999999.*gone/);

  // Garbage is "no status", never a crash: this file is read on a 3s poll.
  fs.writeFileSync(file, '{ not json');
  assert.equal((await api.invoke('loop:status', { projectId })).running, false);

  // Stopping a loop this process does not own leaves a request rather than
  // failing: the loop reads it on its next poll and winds down the way a local
  // stop does. Killing the process would leave a worktree, a claimed task and
  // possibly a half-landed merge behind — the exact things the landing sequence
  // exists to avoid.
  fs.writeFileSync(file, JSON.stringify({ ...record, pid: process.pid, at: new Date().toISOString() }));
  const asked = await api.invoke('loop:stop', { projectId, reason: 'enough for today' });
  assert.equal(asked.requested, true);
  assert.equal(asked.stopped, false, 'asked, not done — the other process decides when');
  assert.equal(JSON.parse(fs.readFileSync(path.join(workspace, '.flyt', 'loop-stop'), 'utf8')).reason, 'enough for today');

  // ...and with nothing running there is nothing to ask.
  fs.rmSync(path.join(workspace, '.flyt', 'loop-stop'));
  fs.writeFileSync(file, JSON.stringify({ ...record, running: false, pid: process.pid }));
  assert.equal((await api.invoke('loop:stop', { projectId })).reason, 'no loop running');
  assert.equal(fs.existsSync(path.join(workspace, '.flyt', 'loop-stop')), false);
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

// --- the benchmark and the archive (DESIGN-SPEC.md §8) -----------------------

test('the score and the archive are reachable from the same map', async () => {
  const { api, engine, dataRoot } = makeApi();
  const repo = path.join(dataRoot, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 't@localhost'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-m', 'initial'], { cwd: repo });
  const { id: projectId } = await api.invoke('project:open', { folder: repo });

  // A repo with no suite says so rather than reporting a perfect score.
  const empty = await api.invoke('bench:list', { projectId });
  assert.deepEqual(empty.cases, []);
  assert.match(empty.problems[0].error, /No suite directory/);
  await assert.rejects(() => api.invoke('bench:compare', { projectId }), err =>
    err instanceof ApiError && err.code === 'not_enough_cards');

  // Two cards, saved the way a run saves them, then compared.
  const scores = path.join(repo, '.flyt', 'scores');
  const card = (at, verified) => scoreSuite({
    suite: 'default', at,
    cases: [{ id: 'a', title: 'a', weight: 1, verified, landed: true, usd: 1, ms: 1000, attempts: 1, escalations: 0, probe: { status: verified ? 'pass' : 'fail' } }]
  });
  saveCard(scores, card('2026-08-12T09:00:00.000Z', false));
  saveCard(scores, card(`${dateStamp()}T09:00:00.000Z`, true));

  const listed = await api.invoke('bench:cards', { projectId });
  assert.equal(listed.cards.length, 2);
  const { comparison } = await api.invoke('bench:compare', { projectId });
  assert.equal(comparison.verdict, 'better');
  assert.match(await api.invoke('bench:report', { projectId }), /# Benchmark/);

  // The archive picks up TODAY's card, never yesterday's, so a day that did not
  // score anything does not inherit a number from the last one that did.
  const written = await api.invoke('archive:write', { projectId });
  assert.equal(written.day.benchmark.score, 1);
  assert.equal((await api.invoke('archive:list', { projectId })).length, 1);
  assert.equal((await api.invoke('archive:trend', { projectId })).direction, null);
  await assert.rejects(() => api.invoke('archive:read', { projectId, date: '2020-01-01' }), err =>
    err instanceof ApiError && err.code === 'no_archive');

  // Nothing about the benchmark is reachable for a project that is not a repo.
  const plain = path.join(dataRoot, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  const { id: plainId } = await api.invoke('project:open', { folder: plain });
  await assert.rejects(() => api.invoke('bench:run', { projectId: plainId }), err =>
    err instanceof ApiError && err.code === 'no_repo');
  assert.equal(engine.registry.listOpen().length, 2);
});

// --- Attempt-scoped worktree lifecycle (WR-02) -------------------------------

// Worktrees default to the user's real home directory, which a test must never
// write into — and two temp repos with the same basename would land in the same
// root. Every worktree test gets its own.
function wtApi() {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'mock', model: 'mock-large' } };
  engine.rebuildRuntimeConfig();
  engine.runtimeConfig.worktreeRoot = path.join(dataRoot, 'worktrees');
  return { engine, api: createApi(engine), dataRoot };
}

// The owner record on disk, found by task id. Tests reach for it to simulate
// the thing that cannot be simulated any other way: the process that wrote it
// no longer existing.
function ownerFile(dataRoot, taskId) {
  const found = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, e.name);
      if (e.isDirectory()) walk(at);
      else if (e.name.endsWith('.json')) found.push(at);
    }
  };
  walk(path.join(dataRoot, 'worktrees'));
  const file = found.find(f => JSON.parse(fs.readFileSync(f, 'utf8')).taskId === taskId);
  if (!file) throw new Error(`no owner record for ${taskId}`);
  return file;
}

function editOwner(dataRoot, taskId, fn) {
  const file = ownerFile(dataRoot, taskId);
  fs.writeFileSync(file, JSON.stringify(fn(JSON.parse(fs.readFileSync(file, 'utf8')))));
}

// A pid this large is not assignable on any platform the app runs on, so it
// cannot be recycled onto something unrelated between writing it and reading it.
const killOwner = (dataRoot, taskId) => editOwner(dataRoot, taskId, r => ({ ...r, pid: 0x7ffffffe }));

async function releaseDeadOwnersFn(pool, taskId) {
  const { releaseDeadOwners } = await import('../core/worktree.js');
  return releaseDeadOwners({
    pool,
    backlog: { get: id => ({ id, status: 'running' }), release: () => {} },
    log: () => {}
  });
}

async function gitProject(api, dataRoot, name = 'repo-wt') {
  const repo = path.join(dataRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 't@localhost'], { cwd: repo });
  await git(['config', 'user.name', 'T'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), '1');
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-m', 'initial'], { cwd: repo });
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  return { repo, projectId };
}

test('work:start mints an attempt, and a stale discard cannot delete the next one', async () => {
  const { api, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot);
  await api.invoke('task:add', { projectId, title: 'Do the thing', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  // Attempt A: started, works, then cancelled — its cleanup is deferred.
  const a = await api.invoke('work:start', { projectId, taskId: task.id });
  assert.ok(a.attemptId, 'work:start returns the attempt it created');
  fs.writeFileSync(path.join(a.dir, 'a.txt'), 'from A');

  // The run is torn down: the attempt releases, but its discard is still in
  // flight when the next attempt begins.
  await api.invoke('work:discard', { projectId, taskId: task.id, attemptId: a.attemptId });

  // Attempt B takes the slot and does real work.
  const b = await api.invoke('work:start', { projectId, taskId: task.id });
  assert.notEqual(b.attemptId, a.attemptId);
  fs.writeFileSync(path.join(b.dir, 'b.txt'), 'from B');

  // A's cleanup finally lands — and must not touch B.
  const late = await api.invoke('work:discard', { projectId, taskId: task.id, attemptId: a.attemptId });
  assert.equal(late.outcome, 'owner-mismatch');
  assert.equal(late.removed, false);
  assert.ok(fs.existsSync(path.join(b.dir, 'b.txt')), "attempt B's work survived");
});

test('work:start refuses to start over a live attempt and says who holds it', async () => {
  const { api, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt2');
  await api.invoke('task:add', { projectId, title: 'Long one', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  const a = await api.invoke('work:start', { projectId, taskId: task.id, runId: 'run-a' });
  await assert.rejects(() => api.invoke('work:start', { projectId, taskId: task.id }), err =>
    err instanceof ApiError && err.status === 409 && err.code === 'attempt_live'
    && err.message.includes(a.attemptId));
  // Nothing was disturbed.
  assert.ok(fs.existsSync(a.dir));
});

// --- a dead owner is not a missing one (t-0101) ------------------------------
//
// The loop process running t-0095 and t-0096 died mid-flight. The status reader
// detected it correctly — "the process that was running it (pid 23148) is gone"
// — and both tasks stayed `running` with `claimedBy: supervisor` and a held
// lock, both worktrees stayed on disk, and `flyt work reconcile` answered "no
// orphaned worktrees", because a worktree WITH an owner record is not orphaned
// by that definition. The owner was gone, not missing. Nothing else in the
// queue could be worked either: a task stuck in `running` is not claimable and
// never times out on its own.

test('a worktree whose owning process is gone reads differently from one with no owner', async () => {
  const { api, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-dead');
  await api.invoke('task:add', { projectId, title: 'Held by a ghost', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const a = await api.invoke('work:start', { projectId, taskId: task.id });

  // Live: not an orphan, whatever else is true.
  assert.equal((await api.invoke('work:reconcile', { projectId })).orphans.some(o => o.taskId === task.id), false);

  // The owner record now names a process that does not exist. A pid this large
  // is not assignable on any platform the app runs on, so it cannot be recycled
  // onto something unrelated between writing this and reading it.
  const owners = path.join(dataRoot, 'worktrees');
  const found = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, e.name);
      if (e.isDirectory()) walk(at);
      else if (e.name.endsWith('.json')) found.push(at);
    }
  };
  walk(owners);
  const file = found.find(f => JSON.parse(fs.readFileSync(f, 'utf8')).taskId === task.id);
  assert.ok(file, 'the owner record exists');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.pid, process.pid, 'the record says who holds it');
  assert.equal(record.host, os.hostname(), 'and on which machine, so a pid means something');
  fs.writeFileSync(file, JSON.stringify({ ...record, pid: 0x7ffffffe }));

  const { orphans } = await api.invoke('work:reconcile', { projectId });
  const mine = orphans.find(o => o.taskId === task.id);
  assert.ok(mine, 'a dead owner IS an orphan — this is what used to say "no orphaned worktrees"');
  assert.equal(mine.kind, 'dead-owner',
    'and it is a different kind from a worktree that never had a record');
  assert.equal(mine.owner.pid, 0x7ffffffe, 'naming the process that is gone');
  assert.equal(mine.attemptId, a.attemptId);
});

test('a heartbeat that is merely stale is not the same news as a process that is gone', async () => {
  // The pid check is the precise half; the heartbeat is the fallback for a
  // record written by another machine. A record from elsewhere must not be
  // called dead on the strength of a pid that means nothing here.
  const { api, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-elsewhere');
  await api.invoke('task:add', { projectId, title: 'Held far away', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  await api.invoke('work:start', { projectId, taskId: task.id });

  const owners = path.join(dataRoot, 'worktrees');
  const found = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, e.name);
      if (e.isDirectory()) walk(at);
      else if (e.name.endsWith('.json')) found.push(at);
    }
  };
  walk(owners);
  const file = found.find(f => JSON.parse(fs.readFileSync(f, 'utf8')).taskId === task.id);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({
    ...record, pid: 0x7ffffffe, host: 'some-other-machine',
    heartbeatAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  }));

  const { orphans } = await api.invoke('work:reconcile', { projectId });
  const mine = orphans.find(o => o.taskId === task.id);
  assert.ok(mine, 'a day-old heartbeat is still an orphan');
  assert.equal(mine.kind, 'abandoned-worktree', 'but not "dead-owner" — that pid is not ours to read');
});

test('a worktree holding work is kept; an empty one is not', async () => {
  // What decides whether a dead owner's tree may be thrown away. Both halves
  // count: on t-0092 five files were sitting UNSTAGED when the attempt died,
  // and a check reading only the commit would have called that tree empty.
  const { api, engine, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-holds');
  await api.invoke('task:add', { projectId, title: 'Wrote something', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const a = await api.invoke('work:start', { projectId, taskId: task.id });

  // The project's own pool, so `dirFor` resolves to the same checkout
  // `work:start` created rather than to a path built the same way by hand.
  const pool = engine.poolFor(projectId);

  assert.equal(await pool.holdsWork(task.id), false, 'a fresh checkout holds nothing');
  fs.writeFileSync(path.join(a.dir, '_scratch.js'), 'console.log(1)\n');
  assert.equal(await pool.holdsWork(task.id), true, 'an uncommitted file is somebody\'s attempt');

  // Fails closed: a tree git cannot read is reported and kept, never deleted
  // on a guess.
  assert.equal(await pool.holdsWork('t-does-not-exist'), false, 'no directory is not "work"');
});

test('the next loop releases what a dead one was holding, and keeps its work', async () => {
  // The recovery that had to be done by hand. Releasing the CLAIM is safe and
  // reversible; deleting the TREE is not, so it happens only when there is
  // provably nothing in it.
  const { api, engine, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-recover');
  await api.invoke('task:add', { projectId, title: 'Held by a corpse', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const a = await api.invoke('work:start', { projectId, taskId: task.id });
  await api.invoke('task:update', { projectId, id: task.id, status: 'running', claimedBy: 'supervisor' });

  const pool = engine.poolFor(projectId);
  killOwner(dataRoot, task.id);

  // The tree holds an uncommitted file, so it is somebody's attempt.
  fs.writeFileSync(path.join(a.dir, 'half-done.js'), 'export const x = 1\n');

  const said = [];
  const { releaseDeadOwners } = await import('../core/worktree.js');
  const out = await releaseDeadOwners({
    pool,
    backlog: {
      get: id => ({ id, status: 'running' }),
      release: (id, patch) => { said.push(`released ${id} as ${patch.status}`); }
    },
    log: line => said.push(line)
  });

  assert.deepEqual(out.released, [task.id], 'the claim comes back');
  assert.deepEqual(out.kept, [task.id], 'and the work stays');
  assert.deepEqual(out.discarded, []);
  assert.ok(fs.existsSync(path.join(a.dir, 'half-done.js')), 'nobody deleted somebody\'s attempt');
  assert.ok(said.some(l => /pid \d+\) is gone/.test(l)), said.join(' | '));
  assert.ok(said.some(l => /holds work and was kept/.test(l)), said.join(' | '));
});

test('a dead owner whose worktree is empty has it discarded', async () => {
  const { api, engine, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-empty');
  await api.invoke('task:add', { projectId, title: 'Wrote nothing', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const a = await api.invoke('work:start', { projectId, taskId: task.id });
  const pool = engine.poolFor(projectId);
  killOwner(dataRoot, task.id);

  const out = await releaseDeadOwnersFn(pool, task.id);
  assert.deepEqual(out.discarded, [task.id], 'nothing in it, so nothing is lost by removing it');
  assert.deepEqual(out.kept, []);
  assert.equal(fs.existsSync(a.dir), false);
});

test('a stale heartbeat from another machine is reported, never acted on', async () => {
  // Only 'dead-owner' is acted on. A stale beat might still be a live process
  // somewhere else, and that is a report rather than a decision.
  const { api, engine, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt-far');
  await api.invoke('task:add', { projectId, title: 'Held far away', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const a = await api.invoke('work:start', { projectId, taskId: task.id });
  const pool = engine.poolFor(projectId);
  editOwner(dataRoot, task.id, r => ({
    ...r, pid: 0x7ffffffe, host: 'some-other-machine',
    heartbeatAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  }));

  const out = await releaseDeadOwnersFn(pool, task.id);
  assert.deepEqual(out, { released: [], kept: [], discarded: [] });
  assert.ok(fs.existsSync(a.dir), 'and the tree is untouched');
});

test('work:touch keeps an attempt live, and work:reconcile reports orphans', async () => {
  const { api, dataRoot } = wtApi();
  const { projectId } = await gitProject(api, dataRoot, 'repo-wt3');
  await api.invoke('task:add', { projectId, title: 'Beating', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  const a = await api.invoke('work:start', { projectId, taskId: task.id });
  assert.equal((await api.invoke('work:touch', { projectId, taskId: task.id, attemptId: a.attemptId })).touched, true);
  // Somebody else's beat is refused.
  assert.equal((await api.invoke('work:touch', { projectId, taskId: task.id, attemptId: 'not-mine' })).touched, false);

  // A live attempt is not an orphan.
  const { orphans } = await api.invoke('work:reconcile', { projectId });
  assert.equal(orphans.some(o => o.taskId === task.id), false);
});
