// Effect-aware completion, through the real executor (WR-01).
//
// The regression this file exists for, exactly as it happened: a code-category
// task was handed write tools, answered with a confident summary of the change
// it had supposedly made, called no tool, changed no file, and was recorded as
// `done`. Downstream tasks then ran on that fiction and Loop only noticed at
// landing, when the diff turned out to be empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runExecutorTask } from '../core/nodes/executor.js';
import { Workspace } from '../core/workspace.js';
import { makeStore, setScript, testConfig } from './helpers.js';

const gitIn = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });

function repoWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-effect-exec-'));
  gitIn(['init', '-b', 'main'], root);
  gitIn(['config', 'user.email', 'test@localhost'], root);
  gitIn(['config', 'user.name', 'Test'], root);
  fs.writeFileSync(path.join(root, 'app.js'), 'export const version = 1;\n');
  gitIn(['add', '-A'], root);
  gitIn(['commit', '-m', 'init', '--no-verify'], root);
  return root;
}

const logEvents = (store, runId) => store.readLog(runId);

function seed(store, runId, root, task) {
  store.writeMeta(runId, { ...store.readMeta(runId), workspace: new Workspace(root).ensure().root });
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', inputs: ['prompt.md'], constraints: [],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending', ...task
  }] });
}

test('a code task that returns prose and changes nothing is a failure, not a completion', async () => {
  const store = makeStore();
  const runId = store.createRun('add a version banner');
  const root = repoWorkspace();
  seed(store, runId, root, {
    title: 'Add the banner', goal: 'Add a version banner to app.js.',
    category: 'Code general', tools: ['create_file', 'edit_file', 'read_file']
  });

  setScript(() => '## Done\n\nI added the version banner to `app.js` and verified it renders correctly.');

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());

  assert.equal(retro.status, 'failed');
  assert.match(retro.problems.join(' '), /required workspace change was not produced/);
  assert.equal(store.readTasks(runId).tasks[0].status, 'failed');

  // The prose survives as evidence — a reader needs to see what it claimed.
  assert.match(store.readTaskOutput(runId, 'task-1'), /version banner/);

  // …and it is recorded as a distinct, inspectable event.
  const missing = logEvents(store, runId).find(e => e.event === 'effect_missing');
  assert.ok(missing, 'effect_missing was logged');
  assert.equal(missing.effect, 'workspace-change');
  assert.equal(missing.writes, 0);

  // The retrospective carries the contract for diagnostics and the UI.
  assert.equal(retro.effect.required, 'workspace-change');
  assert.equal(retro.effect.ok, false);
});

test('the same task succeeds once it actually edits the file', async () => {
  const store = makeStore();
  const runId = store.createRun('add a version banner');
  const root = repoWorkspace();
  seed(store, runId, root, {
    title: 'Add the banner', goal: 'Add a version banner to app.js.',
    category: 'Code general', tools: ['create_file', 'edit_file', 'read_file']
  });

  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT')) {
      return '```tool\n' + JSON.stringify({
        tool: 'create_file', args: { path: 'banner.js', content: 'export const banner = "v1";\n' }
      }) + '\n```';
    }
    return '## Done\n\nAdded `banner.js`.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  assert.equal(store.readTasks(runId).tasks[0].status, 'done');
  assert.equal(retro.effect.ok, true);
  assert.deepEqual(retro.effect.changedPaths, ['banner.js']);
  assert.ok(fs.existsSync(path.join(root, 'banner.js')));
});

test('an analysis task succeeds on its artifact with no repository diff', async () => {
  const store = makeStore();
  const runId = store.createRun('review the architecture');
  const root = repoWorkspace();
  seed(store, runId, root, {
    title: 'Review', goal: 'Assess the module layout.',
    role: 'analyze', tools: ['read_file']
  });

  setScript(() => '## Assessment\n\nThe layout is fine. Three observations follow.');

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  assert.equal(retro.effect.required, 'artifact');
  assert.equal(store.readTasks(runId).tasks[0].status, 'done');
});

test('an authored contract overrides the category inference', async () => {
  const store = makeStore();
  const runId = store.createRun('write up the plan');
  const root = repoWorkspace();
  seed(store, runId, root, {
    title: 'Design note', goal: 'Describe the approach; do not implement it.',
    category: 'Code design', effect: 'artifact', tools: ['read_file']
  });

  setScript(() => '## Approach\n\nDo it in two passes.');

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  assert.equal(retro.effect.required, 'artifact');
  assert.equal(retro.effect.inferred, false);
});

test('a change outside the declared scope does not complete the task', async () => {
  const store = makeStore();
  const runId = store.createRun('change the app');
  const root = repoWorkspace();
  seed(store, runId, root, {
    title: 'Change the app', goal: 'Modify the application source.',
    category: 'Code general', effectScope: ['app.js'],
    tools: ['create_file', 'edit_file', 'read_file']
  });

  // Writes a note instead of touching the application.
  setScript(({ prompt }) => {
    if (!prompt.includes('TOOL RESULT')) {
      return '```tool\n' + JSON.stringify({
        tool: 'create_file', args: { path: 'NOTES.md', content: 'I thought about it.\n' }
      }) + '\n```';
    }
    return '## Done\n\nHandled.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'failed');
  assert.match(retro.problems.join(' '), /outside this task's scope/);
});

test('a task in a workspace that cannot be fingerprinted is accepted but flagged', async () => {
  const store = makeStore();
  const runId = store.createRun('no workspace bound');
  // No workspace in meta at all: nothing to measure.
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Do it', goal: 'Change something.',
    category: 'Code general', inputs: ['prompt.md'], constraints: [], tools: ['read_file'],
    worker: { provider: 'script', model: 'test-model' }, status: 'pending'
  }] });

  setScript(() => '## Done\n\nChanged it.');

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig());
  assert.equal(retro.status, 'success');
  assert.equal(retro.effect.unverified, true);
  assert.ok(logEvents(store, runId).some(e => e.event === 'effect_unverified'));
});
