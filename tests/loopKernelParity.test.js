// The production Loop host, through every kernel seam it depends on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../core/state.js';
import { spendFromRun } from '../core/ledger.js';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { registerProvider } from '../core/adapters/index.js';
import { git } from '../core/worktree.js';
import { waitFor } from './helpers.js';
import {
  bootRunKernel, resumeStackRun, startStackRun, stopStackRun,
} from '../core/kernelHost.js';
import {
  isCanonicalRun, snapshotStackRun, snapshotStoredStackRun, storedStackRunMetadata,
} from '../core/runProjection.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stackRoot = path.join(projectRoot, 'stacks');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

function modelScript(turns, seen = []) {
  let index = 0;
  return {
    seen,
    async call(request) {
      seen.push(request);
      const turn = turns[Math.min(index++, turns.length - 1)];
      return {
        ...turn,
        provider: 'script', model: request.model,
        usage: { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0125 },
      };
    },
  };
}

async function hostFor({
  workspace, runsRoot, store, script, taskId = 't-kernel', skills = [],
  approvalMode = 'always', definitionsRoot = stackRoot,
  worker = { provider: 'script', model: 'worker-model' }, runtimeConfig = {},
}) {
  return bootRunKernel({
    workspaceDir: workspace, runsRoot, store, stackRoot: definitionsRoot,
    sandboxMode: 'danger-full-access',
    approvalMode, worker,
    level: 'high', loopTaskId: taskId, skills,
    runtimeConfig, settings: {},
    resolveModelSource: model => ({ provider: 'script', model }),
    call: script.call,
  });
}

test('production Loop host edits only its worktree and exposes durable status and spend', async () => {
  const runsRoot = tmp('flyt-kernel-runs-');
  const workspace = tmp('flyt-kernel-work-');
  const store = new RunStore(runsRoot);
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'before\n');
  const script = modelScript([
    {
      text: 'I will write the requested file.', finishReason: 'tool_calls',
      message: { tool_calls: [{
        id: 'write-1',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'target.txt', content: 'after\n' }) },
      }] },
    },
    { text: 'Done.', finishReason: 'stop' },
  ]);
  const host = await hostFor({ workspace, runsRoot, store, script });
  const started = await startStackRun({ host, stackId: 'loop-task', input: 'Change target.txt.' });
  const outcome = await started.run.settled();
  const snapshot = await snapshotStackRun(host.ctx, started.runId, host.kernelModule);

  assert.equal(outcome.status, 'done');
  assert.equal(fs.readFileSync(path.join(workspace, 'target.txt'), 'utf8'), 'after\n');
  assert.equal(snapshot.meta.stage, 'done');
  assert.equal(snapshot.meta.workspace, fs.realpathSync(workspace));
  assert.equal(snapshot.meta.loopTaskId, 't-kernel');
  assert.equal(snapshot.meta.nodeStatus.work, 'done');
  assert.equal(snapshot.session.canonical, true);
  assert.equal(isCanonicalRun(store, started.runId), true);
  assert.equal(storedStackRunMetadata(runsRoot, started.runId).model, 'worker-model');

  const spend = spendFromRun(store, started.runId);
  assert.equal(spend.length, 2, 'each settled provider call reaches the existing ledger reader');
  assert.equal(spend.reduce((sum, row) => sum + row.usd, 0), 0.025);

  const reopened = await snapshotStoredStackRun(runsRoot, started.runId);
  assert.equal(reopened.meta.stage, 'done');
  assert.match(reopened.nodeOutputs.work, /Done/);
  await host.dispose();
});

test('the selected Loop band keeps its routing, retry and timeout policy at the adapter boundary', async () => {
  const runsRoot = tmp('flyt-kernel-route-runs-');
  const workspace = tmp('flyt-kernel-route-work-');
  const store = new RunStore(runsRoot);
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'before\n');
  const script = modelScript([{ text: 'No edit.', finishReason: 'stop' }]);
  const host = await hostFor({
    workspace, runsRoot, store, script,
    worker: {
      provider: 'script', model: 'worker-model',
      routing: { costTier: 'high', allowedModels: ['openai/*'] },
    },
    runtimeConfig: {
      retry: { attempts: 4, baseMs: 25, maxMs: 200 },
      timeout: { idleMs: 4_000, hardMs: 12_000 },
    },
  });
  const { run } = await startStackRun({ host, stackId: 'loop-task', input: 'Inspect the project.' });
  await run.settled();

  assert.deepEqual(script.seen[0].routing, { costTier: 'high', allowedModels: ['openai/*'] });
  assert.deepEqual(script.seen[0].retry, { attempts: 4, baseMs: 25, maxMs: 200 });
  assert.deepEqual(script.seen[0].timeout, { idleMs: 4_000, hardMs: 12_000 });
  assert.deepEqual(storedStackRunMetadata(runsRoot, run.runId).routing,
    { costTier: 'high', allowedModels: ['openai/*'] }, 'resume can reconstruct the same band');
  await host.dispose();
});

test('workspace-change is enforced inside the kernel block, before landing', async () => {
  const runsRoot = tmp('flyt-kernel-runs-');
  const workspace = tmp('flyt-kernel-work-');
  const store = new RunStore(runsRoot);
  const script = modelScript([{ text: 'I inspected it and it is fine.', finishReason: 'stop' }]);
  const host = await hostFor({ workspace, runsRoot, store, script });
  const started = await startStackRun({ host, stackId: 'loop-task', input: 'Make a required change.' });
  const outcome = await started.run.settled();
  const snapshot = await snapshotStackRun(host.ctx, started.runId, host.kernelModule);

  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /required workspace change was not produced/);
  assert.equal(snapshot.meta.stage, 'failed');
  assert.match(snapshot.meta.error, /required workspace change/);
  await host.dispose();
});

test('kernel approval refusal reaches the model and cannot mutate the worktree', async () => {
  const runsRoot = tmp('flyt-kernel-approval-runs-');
  const workspace = tmp('flyt-kernel-approval-work-');
  const store = new RunStore(runsRoot);
  fs.writeFileSync(path.join(workspace, 'target.txt'), 'before\n');
  const script = modelScript([
    {
      text: 'Trying the write.', finishReason: 'tool_calls',
      message: { tool_calls: [{
        id: 'denied-write',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'target.txt', content: 'after\n' }) },
      }] },
    },
    { text: 'The write was refused.', finishReason: 'stop' },
  ]);
  const host = await hostFor({ workspace, runsRoot, store, script, approvalMode: 'never' });
  const { run } = await startStackRun({ host, stackId: 'loop-task', input: 'Change target.txt.' });
  const outcome = await run.settled();

  assert.equal(outcome.status, 'failed', 'workspace effect cannot pass after a denied write');
  assert.equal(fs.readFileSync(path.join(workspace, 'target.txt'), 'utf8'), 'before\n');
  const toolMessage = script.seen.at(-1).messages.find(message => message.role === 'tool');
  assert.match(String(toolMessage?.content), /refus|deni|approval/i);
  await host.dispose();
});

test('a malformed canonical stack keeps its parser diagnostic', async () => {
  const runsRoot = tmp('flyt-kernel-invalid-runs-');
  const workspace = tmp('flyt-kernel-invalid-work-');
  const definitionsRoot = tmp('flyt-kernel-invalid-stacks-');
  const store = new RunStore(runsRoot);
  fs.writeFileSync(path.join(definitionsRoot, 'broken.stack.yaml'), 'version: 2\nid: broken\nblocks: [\n');
  const host = await hostFor({
    workspace, runsRoot, store, definitionsRoot,
    script: modelScript([{ text: 'should not run', finishReason: 'stop' }]),
  });

  await assert.rejects(
    () => startStackRun({ host, stackId: 'broken', input: 'Do not start.' }),
    /parse|yaml|line|unterminated|unexpected/i,
  );
  await host.dispose();
});

test('an interrupted session resumes from its log and explains the missing tool result', async () => {
  const runsRoot = tmp('flyt-kernel-runs-');
  const workspace = tmp('flyt-kernel-work-');
  const store = new RunStore(runsRoot);
  fs.writeFileSync(path.join(workspace, 'resume.txt'), 'before\n');
  const firstScript = modelScript([{ text: 'unused', finishReason: 'stop' }]);
  const first = await hostFor({ workspace, runsRoot, store, script: firstScript, taskId: 't-resume' });
  const session = await first.ctx.sessions.open('interrupted-run');
  await session.append({
    type: 'run.created',
    data: {
      runId: 'interrupted-run', stackId: 'loop-task', input: 'Finish resume.txt.', prompt: 'Finish resume.txt.',
      workspace, approvalMode: 'always', loopTaskId: 't-resume', model: 'worker-model', provider: 'script', level: 'high', skills: [],
    },
  });
  await session.append({ type: 'run.stage', data: { stage: 'execution' } });
  await session.append({ type: 'block.status', data: { blockId: 'work', status: 'active', use: 'flyt-blocks-core:work' } });
  await session.append({ type: 'turn.start', data: { runId: 'interrupted-run', turn: 1, blockId: 'work' } });
  await session.append({ type: 'message.system', data: { content: 'work' } });
  await session.append({ type: 'message.user', data: { content: 'Finish resume.txt.' } });
  await session.append({ type: 'step.start', data: { runId: 'interrupted-run', blockId: 'work', step: 1 } });
  await session.append({ type: 'llm.request', data: { callId: 'old-1', model: 'worker-model', blockId: 'work', step: 1 } });
  await session.append({
    type: 'llm.response',
    data: { callId: 'old-1', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'lost', name: 'read_file', args: { path: 'resume.txt' } }] },
  });
  await session.append({ type: 'tool.call', data: { callId: 'lost', name: 'read_file', args: { path: 'resume.txt' } } });
  await first.dispose();

  const seen = [];
  const secondScript = modelScript([
    {
      text: 'Recovering after the interrupted read.', finishReason: 'tool_calls',
      message: { tool_calls: [{
        id: 'write-resume',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'resume.txt', content: 'resumed\n' }) },
      }] },
    },
    { text: 'Recovered and done.', finishReason: 'stop' },
  ], seen);
  const second = await hostFor({ workspace, runsRoot, store, script: secondScript, taskId: 't-resume' });
  const resumed = await resumeStackRun(second, 'interrupted-run');
  const outcome = await resumed.run.settled();

  assert.equal(outcome.status, 'done');
  assert.equal(fs.readFileSync(path.join(workspace, 'resume.txt'), 'utf8'), 'resumed\n');
  assert.ok(seen[0].messages.some(message => message.role === 'tool' && /never returned/i.test(message.content)),
    'the resumed model is told exactly what was lost');
  const snapshot = await snapshotStackRun(second.ctx, 'interrupted-run', second.kernelModule);
  assert.equal(snapshot.meta.stage, 'done');
  assert.ok(snapshot.session.head > 10);
  await second.dispose();
});

test('stop reaches a live kernel run, settles cooperatively, and then fails honestly', async () => {
  const runsRoot = tmp('flyt-kernel-stop-runs-');
  const workspace = tmp('flyt-kernel-stop-work-');
  const store = new RunStore(runsRoot);
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const seen = [];
  const script = {
    seen,
    call: async request => {
      seen.push(request);
      enter();
      await held;
      return { text: 'Stopped at the next safe boundary.', finishReason: 'stop' };
    },
  };
  const host = await hostFor({ workspace, runsRoot, store, script });
  const started = await startStackRun({ host, stackId: 'loop-task', input: 'Wait for a stop.' });
  await entered;

  assert.deepEqual(await stopStackRun(host.ctx, started.runId, 'parity stop'), { ok: true });
  release();
  assert.deepEqual(await started.run.settled(), { status: 'stopped', reason: 'parity stop' });
  await waitFor(() => !host.ctx.agents.get(started.runId), { label: 'stopped run to leave live registry' });
  assert.deepEqual(await stopStackRun(host.ctx, started.runId), {
    ok: false, error: 'not-live', message: `Kernel run ${started.runId} is not live in this process.`,
  });
  assert.deepEqual(await stopStackRun({}, 'missing'), {
    ok: false, error: 'kernel-unavailable', message: 'No agents seam.',
  });
  await host.dispose();
});

test('kernel session activity uses the existing live and incremental run channels', async () => {
  const repo = tmp('flyt-kernel-push-work-');
  const dataRoot = tmp('flyt-kernel-push-data-');
  await git(['init', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 'kernel-test@example.test'], { cwd: repo });
  await git(['config', 'user.name', 'Kernel Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'target.txt'), 'before\n');
  await git(['add', '.'], { cwd: repo });
  await git(['commit', '-m', 'base'], { cwd: repo });

  let release;
  let secondCall;
  const held = new Promise(resolve => { release = resolve; });
  const enteredSecond = new Promise(resolve => { secondCall = resolve; });
  let calls = 0;
  const adapter = async () => {
    calls++;
    if (calls === 1) {
      return {
        text: 'Writing.', finishReason: 'tool_calls',
        message: { tool_calls: [{
          id: 'push-write',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'target.txt', content: 'after\n' }) },
        }] },
      };
    }
    secondCall();
    await held;
    return { text: 'Done.', finishReason: 'stop' };
  };
  adapter.canServe = model => model === 'mock-push';
  registerProvider('mock', adapter);

  const events = [];
  const engine = createEngine({
    projectRoot, dataRoot, userDataDir: dataRoot,
    emit: (type, payload) => events.push({ type, payload }),
  });
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  const runId = await api.invoke('stack:run', {
    projectId, stackId: 'loop-task', input: 'Change target.txt.', workspaceDir: repo,
    loopTaskId: 't-push', worker: { provider: 'mock', model: 'mock-push' },
  });
  await enteredSecond;

  const liveUpdate = await waitFor(() => events.find(event => (
    event.type === 'run:update' && event.payload.runId === runId
    && event.payload.full?.retrospectives?.work?.toolCalls?.length === 1
  )), { label: 'live canonical kernel update' });
  assert.equal(liveUpdate.payload.full.meta.stage, 'execution');
  assert.equal(liveUpdate.payload.full.meta.nodeStatus.work, 'active');
  assert.deepEqual(await api.invoke('run:live', { projectId }), { [projectId]: [runId] });
  assert.ok(events.some(event => event.type === 'project:activity'
    && event.payload.projectId === projectId && event.payload.live.includes(runId)));

  release();
  await waitFor(() => events.some(event => (
    event.type === 'run:update' && event.payload.runId === runId && event.payload.patch?.meta?.stage === 'done'
  )), { label: 'terminal kernel patch' });
  await waitFor(() => events.some(event => event.type === 'project:activity'
    && event.payload.projectId === projectId && event.payload.live.length === 0),
  { label: 'kernel activity to clear' });
  assert.deepEqual(await api.invoke('run:live', { projectId }), { [projectId]: [] });
});

test('run:restartBlock durably re-pins a failed kernel block and starts it on the new route', async () => {
  const repo = tmp('flyt-kernel-repin-work-');
  const dataRoot = tmp('flyt-kernel-repin-data-');
  await git(['init', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 'kernel-test@example.test'], { cwd: repo });
  await git(['config', 'user.name', 'Kernel Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'target.txt'), 'before\n');
  await git(['add', '.'], { cwd: repo });
  await git(['commit', '-m', 'base'], { cwd: repo });

  const seen = [];
  const adapter = async request => {
    seen.push(request);
    if (request.model === 'mock-old') {
      return { text: 'I did not make the required edit.', finishReason: 'stop' };
    }
    const wrote = (request.messages ?? []).some(message => (
      message.role === 'tool' && /target\.txt/.test(String(message.content ?? ''))
    ));
    if (!wrote) {
      return {
        text: 'Applying the corrected attempt.', finishReason: 'tool_calls',
        message: { tool_calls: [{
          id: 'repin-write',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'target.txt', content: 'after\n' }) },
        }] },
      };
    }
    return { text: 'Corrected.', finishReason: 'stop' };
  };
  adapter.canServe = model => String(model).startsWith('mock-');
  registerProvider('mock', adapter);

  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  const runId = await api.invoke('stack:run', {
    projectId, stackId: 'loop-task', input: 'Change target.txt.', workspaceDir: repo,
    loopTaskId: 't-repin', worker: {
      provider: 'mock', model: 'mock-old', routing: { costTier: 'high' },
    },
  });
  const entry = engine.registry.get(projectId);
  await waitFor(() => {
    try { return entry.store.readMeta(runId).stage === 'failed'; } catch { return false; }
  }, { label: 'first kernel attempt to fail' });

  const guidance = 'Use the file tool and make the requested edit.';
  await api.invoke('run:restartBlock', {
    projectId, runId, blockId: 'work', guidance,
    worker: { provider: 'mock', model: 'mock-new', routing: { costTier: 'low' } },
  });
  await waitFor(() => {
    try { return entry.store.readMeta(runId).stage === 'done'; } catch { return false; }
  }, { label: 're-pinned kernel attempt to finish' });

  assert.equal(fs.readFileSync(path.join(repo, 'target.txt'), 'utf8'), 'after\n');
  const newCalls = seen.filter(request => request.model === 'mock-new');
  assert.ok(newCalls.length >= 2, 'the restarted block actually executed with the new adapter route');
  assert.deepEqual(newCalls[0].routing, { costTier: 'low' });
  assert.equal(seen.filter(request => request.model === 'mock-old').length, 1);

  const events = fs.readFileSync(path.join(entry.store.runDir(runId), 'session.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === 'run.reconfigured'
    && event.data?.model === 'mock-new' && event.data?.provider === 'mock'));
  assert.ok(events.some(event => event.type === 'block.status'
    && event.data?.blockId === 'work' && event.data?.status === 'pending'));
  assert.ok(events.some(event => event.type === 'message.user' && event.data?.content === guidance));
  const metadata = storedStackRunMetadata(entry.store.rootDir, runId);
  assert.equal(metadata.model, 'mock-new');
  assert.equal(metadata.provider, 'mock');
  assert.deepEqual(metadata.routing, { costTier: 'low' });
  assert.equal((await api.invoke('run:snapshot', { projectId, runId })).meta.stage, 'done');

  const pauseEnded = await api.invoke('run:pause', { projectId, runId });
  assert.equal(pauseEnded.ok, false);
  assert.equal(pauseEnded.error, 'not-live');
  await waitFor(() => api.runController.list(projectId).length === 0,
    { label: 'restarted kernel host disposal' });
});

test('Supervisor has no compatibility fallback for unattended execution', async () => {
  const source = fs.readFileSync(path.join(projectRoot, 'core', 'supervisor.js'), 'utf8');
  const begin = source.slice(source.indexOf('async #begin(task)'), source.indexOf('// What the run is told.'));
  assert.match(begin, /this\.invoke\('stack:run'/);
  assert.doesNotMatch(begin, /this\.invoke\('flow:run'/);
});

test('a fresh Supervisor claim reaches kernel, gates, review, merge and canary', async () => {
  const repo = tmp('flyt-kernel-supervisor-');
  const dataRoot = tmp('flyt-kernel-data-');
  await git(['init', '-b', 'main'], { cwd: repo });
  await git(['config', 'user.email', 'kernel-test@example.test'], { cwd: repo });
  await git(['config', 'user.name', 'Kernel Test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'target.js'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({
    name: 'kernel-supervisor-fixture', private: true,
    scripts: { test: 'node --check target.js' },
  }, null, 2));

  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await git(['add', '.'], { cwd: repo });
  await git(['commit', '-m', 'base'], { cwd: repo });

  const adapter = async request => {
    if (/ROLE: diff-review/.test(request.system ?? '')) {
      return {
        text: '```json\n{"verdict":"approve","reason":"The requested file changed and the gate passed.","changes":[],"concerns":[]}\n```',
        usage: { input_tokens: 200, output_tokens: 40, cost: 0.002 },
      };
    }
    const messages = request.messages ?? [];
    const wrote = messages.some(message => message.role === 'tool' && /target\.js/.test(message.content ?? ''));
    if (!wrote) {
      return {
        text: 'Writing the requested change.', finishReason: 'tool_calls',
        message: { tool_calls: [{
          id: 'supervisor-write',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'target.js', content: 'export const value = 2;\n' }) },
        }] },
        usage: { input_tokens: 500, output_tokens: 50, cost: 0.004 },
      };
    }
    return {
      text: 'Done.', finishReason: 'stop',
      usage: { input_tokens: 600, output_tokens: 30, cost: 0.003 },
    };
  };
  adapter.canServe = model => String(model).startsWith('mock-');
  registerProvider('mock', adapter);

  engine.settings.workers = {
    executor: { provider: 'mock', model: 'mock-large' },
    reviewer: { provider: 'mock', model: 'mock-large' },
  };
  engine.rebuildRuntimeConfig();

  const task = await api.invoke('task:add', {
    projectId,
    title: 'Bump the exported value',
    goal: 'Change target.js so value is 2.',
    body: 'Change only target.js and keep it valid JavaScript.',
    blastRadius: ['target.js'],
    gates: ['node --check target.js'],
  });
  await api.invoke('loop:start', {
    projectId, maxTasks: 1, only: [task.id],
    worker: { provider: 'mock', model: 'mock-large' },
    reviewer: { provider: 'mock', model: 'mock-large' },
  });

  const landed = await waitFor(() => {
    const current = engine.backlogFor(projectId).get(task.id);
    return current.status === 'landed' ? current : null;
  }, { timeoutMs: 30_000, intervalMs: 100, label: 'kernel Loop task to land' });
  assert.equal(fs.readFileSync(path.join(repo, 'target.js'), 'utf8').trim(), 'export const value = 2;');
  assert.equal(landed.status, 'landed');
  assert.equal(landed.runIds.length, 1);
  assert.equal(isCanonicalRun(engine.registry.get(projectId).store, landed.runIds[0]), true);
  let status = await api.invoke('loop:status', { projectId });
  const statusDeadline = Date.now() + 5_000;
  while ((status.running || status.landed !== 1) && Date.now() < statusDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
    status = await api.invoke('loop:status', { projectId });
  }
  assert.equal(status.landed, 1);
  assert.equal(status.running, false);
  assert.ok((await api.invoke('ledger:totals', { projectId })).calls >= 2);
  const entry = engine.registry.get(projectId);
  await waitFor(() => api.runController.list(projectId).length === 0,
    { timeoutMs: 5_000, label: 'settled kernel host disposal' });
});
