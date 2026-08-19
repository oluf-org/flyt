// bash tool (V1 task 3): runs a shell command with the bound workspace as cwd,
// captures stdout/stderr/exit code, logs every call, and is reachable through
// the agent's tool loop. Commands use `node -e` so the tests are cross-platform.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../core/tools/index.js';
import { runExecutorTask } from '../core/nodes/executor.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript, testConfig } from './helpers.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llm-flow-bash-'));

function boundCtx() {
  const store = makeStore();
  const runId = store.createRun('bash test');
  const proj = tmpDir();
  const workspace = new Workspace(proj).ensure();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: workspace.root });
  return { store, runId, taskId: 'task-1', workspace, proj };
}

const logEvents = (store, runId) =>
  fs.readFileSync(path.join(store.runDir(runId), 'log.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);

const NODE = JSON.stringify(process.execPath); // quote for spaces in the path

test('bash: captures stdout and a zero exit code', async () => {
  const ctx = boundCtx();
  const rec = await executeTool('bash', { command: `${NODE} -e "process.stdout.write('hello')"` }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.exitCode, 0);
  assert.equal(rec.result.stdout, 'hello');
  assert.equal(rec.result.target, 'workspace');
});

test('bash: runs with the workspace as the working directory', async () => {
  const ctx = boundCtx();
  // Write a relative-path file; it must land inside the bound workspace.
  const rec = await executeTool('bash',
    { command: `${NODE} -e "require('fs').writeFileSync('from-bash.txt','ok')"` }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(ctx.proj, 'from-bash.txt'), 'utf8'), 'ok');
});

test('bash: a non-zero exit is returned (not thrown) with stderr', async () => {
  const ctx = boundCtx();
  const rec = await executeTool('bash',
    { command: `${NODE} -e "process.stderr.write('boom'); process.exit(3)"` }, ctx);
  assert.equal(rec.ok, true);            // the tool call itself succeeded
  assert.equal(rec.result.exitCode, 3);  // the command failed — the model can react
  assert.match(rec.result.stderr, /boom/);
});

test('bash: every command is captured to log.jsonl', async () => {
  const ctx = boundCtx();
  await executeTool('bash', { command: `${NODE} -e "process.stdout.write('x')"` }, ctx);
  const calls = logEvents(ctx.store, ctx.runId).filter(e => e.event === 'tool_call' && e.tool === 'bash');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, true);
  assert.equal(calls[0].result.exitCode, 0);
});

test('executor: an agentTask runs a command in the real repo and captures its output', async () => {
  const store = makeStore();
  const runId = store.createRun('run the tests');
  const proj = tmpDir();
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: new Workspace(proj).ensure().root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Check the toolchain', goal: 'Run a build/test command.',
    inputs: ['prompt.md'], constraints: [], tools: ['bash'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });

  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT'))
      return '```tool\n' + JSON.stringify({ tool: 'bash', args: { command: `${NODE} -e "console.log('BUILD_OK')"` } }) + '\n```';
    return '## Done\nRan the command; build reported OK.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  const bashCall = logEvents(store, runId).find(e => e.event === 'tool_call' && e.tool === 'bash');
  assert.ok(bashCall, 'bash call was logged');
  assert.equal(bashCall.result.exitCode, 0);
  assert.match(bashCall.result.stdout, /BUILD_OK/); // command output captured to the audit log
});

test('executor: agentTask honors config.maxToolIterations', async () => {
  const store = makeStore();
  const runId = store.createRun('bounded executor tools');
  const proj = tmpDir();
  fs.writeFileSync(path.join(proj, 'sample.txt'), 'ok');
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: new Workspace(proj).ensure().root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Read repeatedly', goal: 'Exercise the configured cap.',
    inputs: ['prompt.md'], constraints: [], tools: ['read_file'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });

  setScript(() => '```tool\n' + JSON.stringify({ tool: 'read_file', args: { path: 'sample.txt' } }) + '\n```');

  await runExecutorTask(store, runId, 'task-1', testConfig({ maxToolIterations: 2 }));
  const calls = logEvents(store, runId).filter(e => e.event === 'tool_call' && e.tool === 'read_file');
  assert.equal(calls.length, 2, 'the executor uses the configured cap instead of runAgent\'s fallback');
});

test('bash: falls back to the run sandbox when no workspace is bound', async () => {
  const store = makeStore();
  const runId = store.createRun('no workspace');
  const ctx = { store, runId, taskId: 'task-1', workspace: null };
  const rec = await executeTool('bash', { command: `${NODE} -e "process.stdout.write('ok')"` }, ctx);
  assert.equal(rec.ok, true);
  assert.equal(rec.result.target, 'run-workspace');
  assert.equal(rec.result.exitCode, 0);
});
