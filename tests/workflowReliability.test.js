// The end-to-end workflow reliability harness (WR-07).
//
// Every mechanism this exercises already has strong unit tests. The production
// failures nevertheless happened, because they lived at the SEAMS between them:
//
//   UI retry            → the persisted task worker (the retry ran on the model
//                         that had just failed)
//   Settings priority   → default worker selection (a reorder moved some calls
//                         and not others)
//   old cleanup         → the new attempt's worktree (a late discard deleted
//                         live work)
//   model prose         → repository effect (a green node on an empty diff)
//   plan shape          → plan usefulness (nine tasks, inputs nobody produced)
//   runtime failure     → routing (spawn EPERM read as a model problem)
//
// A passing unit suite did not prove the real Flow-to-Loop workflow. So this
// runs the ACTUAL engine and command surface against a real temporary git
// repository, with scripted providers, and deliberately exercises failure and
// recovery rather than the happy path. Deterministic and key-free: no network,
// no credentials, one command.
//
// Each test names the invariant it protects, so a failure here says which one
// broke rather than only that something did.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi, ApiError } from '../core/api.js';
import { git } from '../core/worktree.js';
import { runExecutorTask } from '../core/nodes/executor.js';
import { StackRunner, resolveWorkerRoute } from '../core/stackRunner.js';
import { validatePlan, plannerLimits } from '../core/planContract.js';
import { makeStore, setScript, testConfig, waitForStage } from './helpers.js';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-wr-'));
const NODE = JSON.stringify(process.execPath);

// A repository with one source file and a small test gate — the smallest thing
// that can actually be verified, merged and canaried.
async function scenarioRepo(dataRoot, name = 'subject') {
  const root = path.join(dataRoot, name);
  fs.mkdirSync(root, { recursive: true });
  await git(['init', '-b', 'main'], { cwd: root });
  await git(['config', 'user.email', 'test@localhost'], { cwd: root });
  await git(['config', 'user.name', 'Test'], { cwd: root });
  fs.writeFileSync(path.join(root, 'app.js'), 'export const banner = null;\n');
  // A "suite" that is just a script, so it can be made red on demand without
  // depending on a real test runner.
  fs.writeFileSync(path.join(root, 'suite.js'),
    'const n = 2;\nconsole.log("# tests " + n);\n');
  fs.mkdirSync(path.join(root, '.flyt'), { recursive: true });
  fs.writeFileSync(path.join(root, '.flyt', 'config.json'),
    JSON.stringify({ gates: [`${NODE} suite.js`], gateTimeoutMs: 30000 }, null, 2));
  await git(['add', '-A'], { cwd: root });
  await git(['commit', '-m', 'initial', '--no-verify'], { cwd: root });
  return root;
}

// An engine whose worktrees stay inside the test's own temp dir — never the
// user's home directory, and never shared between two tests.
function harness() {
  const dataRoot = tmp();
  const engine = createEngine({ projectRoot, dataRoot, userDataDir: dataRoot });
  engine.settings.workers = { executor: { provider: 'script', model: 'model-A' } };
  engine.rebuildRuntimeConfig();
  engine.runtimeConfig.worktreeRoot = path.join(dataRoot, 'worktrees');
  return { engine, api: createApi(engine), dataRoot };
}

const logOf = (store, runId) => store.readLog(runId) ?? [];

// --- INVARIANT: a runtime that cannot start is not a model failure ----------

test('WR-07/1: an auto route survives a CLI spawn failure by falling through', async () => {
  const store = makeStore();
  const runId = store.createRun('plan the banner change');
  store.writeTasks(runId, { tasks: [{
    id: 'task-1', title: 'Plan', goal: 'Describe the change.',
    inputs: ['prompt.md'], constraints: [], tools: [],
    worker: { provider: 'auto', model: 'planner' }, status: 'pending'
  }] });

  const calls = [];
  setScript(({ model }) => {
    calls.push(model);
    // The real failure that started this work: the vendor CLI refusing to launch
    // before doing any model work at all.
    if (model === 'codex-model') throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    return '## Plan\n\nAdd a banner to app.js and cover it in the suite.';
  });

  const retro = await runExecutorTask(store, runId, 'task-1', testConfig({
    providerPriority: ['codex', 'openrouter'],
    resolveModelSource: (model, pinned) => pinned === 'openrouter'
      ? { provider: 'script', model: 'openrouter-model', apiKey: 'k' }
      : { provider: 'script', model: 'codex-model', apiKey: 'k' }
  }));

  assert.equal(retro.status, 'success');
  assert.deepEqual(calls, ['codex-model', 'openrouter-model'],
    'it tried the priority-first provider, then fell through in priority order');

  const fell = logOf(store, runId).find(e => e.event === 'route_fallback');
  assert.equal(fell.code, 'runtime-permission');
  assert.match(fell.remedy, /Settings → Providers/);
});

// --- INVARIANT: a plan must be useful, not merely well-formed ----------------

test('WR-07/2: an over-fragmented plan is rejected, and a bounded one is accepted', () => {
  const limits = plannerLimits({});
  const available = ['prompt.md'];

  // What the real planner did to a focused UI change: nine tasks, one of them
  // requiring a document nothing writes.
  const overFragmented = [
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`, effect: 'artifact', outputs: [`t${i}.md`], requiredInputs: ['prompt.md']
    })),
    { id: 't8', effect: 'workspace-change', requiredInputs: ['design-notes.md'] }
  ];
  const bad = validatePlan(overFragmented, { limits, available });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(' '), /over the limit/);
  assert.match(bad.errors.join(' '), /requires "design-notes\.md"/);

  // The corrected plan: two tasks, each independently verifiable, every
  // required input produced by something.
  const corrected = [
    { id: 'design', effect: 'artifact', outputs: ['design.md'], requiredInputs: ['prompt.md'] },
    {
      id: 'implement', effect: 'workspace-change', effectScope: ['app.js', 'suite.js'],
      requiredInputs: ['prompt.md', 'design.md'], dependsOn: ['design']
    }
  ];
  const good = validatePlan(corrected, { limits, available });
  assert.equal(good.ok, true, good.errors.join('; '));
  assert.equal(good.metrics.taskCount, 2);
});

// --- INVARIANT: prose is not a repository change ----------------------------
// --- INVARIANT: a retry runs on the model the user chose ---------------------

test('WR-07/3: a no-effect executor fails, and the retry on worker B changes the repo', async () => {
  const { api, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot);
  await api.invoke('project:open', { folder: repo });

  const store = makeStore();
  const runner = new StackRunner(store, testConfig({ workers: { executor: { provider: 'script', model: 'model-A' } } }));
  const flow = {
    id: 'f', name: 'Implement the banner',
    nodes: [
      { id: 'in', type: 'input', data: { text: 'add a version banner to app.js' }, position: { x: 0, y: 0 } },
      {
        id: 'implement', type: 'agentTask',
        data: {
          title: 'Implement the banner', goal: 'Add the banner to app.js.',
          category: 'Code general', tools: ['create_file', 'edit_file', 'read_file'],
          worker: { provider: 'script', model: 'model-A' }
        },
        position: { x: 0, y: 0 }
      },
      { id: 'out', type: 'output', data: {}, position: { x: 0, y: 0 } }
    ],
    edges: [{ id: 'e1', source: 'in', target: 'implement' }, { id: 'e2', source: 'implement', target: 'out' }]
  };

  const calls = [];
  setScript(({ model, prompt }) => {
    calls.push(model);
    // Worker A: a confident summary of work it never did. No tool call, no edit.
    if (model === 'model-A') {
      return '## Done\n\nI added the version banner to `app.js` and verified it renders.';
    }
    // Worker B: actually edits the file.
    if (!prompt.includes('TOOL RESULT')) {
      return '```tool\n' + JSON.stringify({
        tool: 'edit_file',
        args: { path: 'app.js', old: 'export const banner = null;', new: 'export const banner = "v1";' }
      }) + '\n```';
    }
    return '## Done\n\nEdited `app.js`.';
  });

  const runId = runner.start(flow, { workspace: repo });
  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'failed',
    'INVARIANT VIOLATED if done: a no-diff executor must not be marked successful');

  // The failure is the RIGHT failure, named and recorded.
  const missing = logOf(store, runId).find(e => e.event === 'effect_missing');
  assert.ok(missing, 'effect_missing was recorded');
  assert.equal(missing.effect, 'workspace-change');
  assert.equal(missing.writes, 0);
  const failedRetro = store.readRetrospectives(runId)['executor-task-1'];
  assert.match(failedRetro.problems.join(' '), /required workspace change was not produced/);
  assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'export const banner = null;\n',
    'nothing was changed, which is exactly why it failed');

  // Retry on worker B — and it must actually go to B.
  const res = runner.restartNode(runId, 'implement', '', { provider: 'script', model: 'model-B' });
  assert.deepEqual(res.effectiveWorker, { provider: 'script', model: 'model-B' });

  assert.equal(await waitForStage(store, runId, ['done', 'failed']), 'done');
  assert.equal(calls[calls.length - 1], 'model-B',
    'INVARIANT VIOLATED if model-A: the retry called the model that had just failed');
  assert.equal(calls.slice(1).includes('model-A'), false);

  // The repository actually changed, in scope.
  assert.match(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), /banner = "v1"/);
  const okRetro = store.readRetrospectives(runId)['executor-task-1'];
  assert.equal(okRetro.effect.ok, true);
  assert.deepEqual(okRetro.effect.changedPaths, ['app.js']);
});

// --- INVARIANT: a stale cleanup cannot touch a newer attempt -----------------

test('WR-07/4: cancellation cleanup from attempt A cannot delete attempt B', async () => {
  const { api, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot, 'race-subject');
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await api.invoke('task:add', { projectId, title: 'Add the banner', body: 'Because.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  // Attempt A starts and does work, then is cancelled — its cleanup is deferred.
  const a = await api.invoke('work:start', { projectId, taskId: task.id, runId: 'run-A' });
  fs.writeFileSync(path.join(a.dir, 'from-A.js'), 'A was here\n');
  await api.invoke('work:discard', { projectId, taskId: task.id, attemptId: a.attemptId });

  // Attempt B takes the slot and does real work.
  const b = await api.invoke('work:start', { projectId, taskId: task.id, runId: 'run-B' });
  assert.notEqual(b.attemptId, a.attemptId);
  fs.writeFileSync(path.join(b.dir, 'from-B.js'), 'B was here\n');

  // A's cleanup finally lands, believing it still owns the path.
  const late = await api.invoke('work:discard', { projectId, taskId: task.id, attemptId: a.attemptId });
  assert.equal(late.outcome, 'owner-mismatch',
    'INVARIANT VIOLATED: a stale cleanup was allowed to proceed');
  assert.ok(fs.existsSync(path.join(b.dir, 'from-B.js')),
    "INVARIANT VIOLATED: attempt B's work was deleted by attempt A's cleanup");

  // And starting a third attempt over a LIVE one is refused, not resolved by
  // deleting somebody's tree.
  await assert.rejects(() => api.invoke('work:start', { projectId, taskId: task.id }), err =>
    err instanceof ApiError && err.code === 'attempt_live');
});

// --- INVARIANT: gates, review, merge and canary actually run -----------------

test('WR-07/5: verified work lands through gates, review, merge and canary', async () => {
  const { api, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot, 'landing-subject');
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await api.invoke('task:add', { projectId, title: 'Add the banner', body: 'Add a banner to app.js.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  // The agent's work, as the executor would have left it in the worktree.
  fs.writeFileSync(path.join(wt.dir, 'app.js'), 'export const banner = "v1";\n');

  // Gates, in the worktree, for real.
  const verified = await api.invoke('work:verify', { projectId, taskId: task.id });
  assert.equal(verified.ok, true, `gates must pass in the worktree: ${JSON.stringify(verified.results)}`);

  // An independent reviewer approves the diff.
  setScript(() => JSON.stringify({ verdict: 'approve', reason: 'Adds the banner; nothing else touched.' }));

  const landed = await api.invoke('work:land', {
    projectId, taskId: task.id, attemptId: wt.attemptId,
    reviewer: { provider: 'script', model: 'reviewer' }
  });

  assert.equal(landed.landed, true, `it must land: ${landed.stage} — ${landed.guidance ?? ''}`);
  // The steps were really run, not skipped.
  const steps = new Set(landed.steps.map(s => s.step));
  for (const step of ['gates', 'checks', 'review', 'land']) {
    assert.ok(steps.has(step), `the "${step}" step must have run — steps: ${[...steps].join(', ')}`);
  }
  // The canary surfaces as its OUTPUT — the suite's own words on the merged
  // base, which is also the baseline the next task's test-count check needs.
  // Asserting on the output rather than a boolean is what proves it really ran.
  assert.ok(landed.canaryOutput, 'the post-merge canary must have run and reported');
  assert.match(landed.canaryOutput, /# tests 2/);

  // The change is on the base branch of the real repository.
  const onMain = await git(['show', 'main:app.js'], { cwd: repo });
  assert.match(onMain, /banner = "v1"/, 'the requested change is on main');
  assert.equal((await api.invoke('task:get', { projectId, id: task.id })).status, 'landed');
});

test('WR-07/5b: cleanup failure cannot erase a successful landing or requeue it later', async () => {
  const { api, engine, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot, 'landing-cleanup-subject');
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await api.invoke('task:add', { projectId, title: 'Land despite a held handle', body: 'Change app.js.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });
  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  fs.writeFileSync(path.join(wt.dir, 'app.js'), 'export const banner = "cleanup-safe";\n');
  setScript(() => JSON.stringify({ verdict: 'approve', reason: 'The change is focused and tested.' }));

  // Deterministic version of Windows retaining an editor/terminal handle: the
  // merge and canary finish, but the first attempt to remove this exact tree
  // fails. The second call is the operator retry after closing that handle.
  const pool = engine.poolFor(projectId);
  const remove = pool.remove.bind(pool);
  let failOnce = true;
  pool.remove = async (...args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated open handle kept the worktree busy');
    }
    return remove(...args);
  };

  const landed = await api.invoke('work:land', {
    projectId, taskId: task.id, attemptId: wt.attemptId,
    reviewer: { provider: 'script', model: 'reviewer' },
  });
  assert.equal(landed.landed, true);
  assert.ok(landed.mergeSha);
  assert.match(landed.canaryOutput, /# tests 2/);
  assert.equal(landed.cleanup.ok, false);
  assert.equal(landed.cleanup.outcome, 'failed');
  assert.match(landed.cleanup.remedy, new RegExp(`work discard ${task.id}.*${wt.attemptId}`));
  assert.ok(fs.existsSync(wt.dir), 'the failed cleanup is retained for a retry');
  assert.equal((await api.invoke('task:get', { projectId, id: task.id })).status, 'landed');
  assert.ok((await api.invoke('loop:log', { projectId, taskId: task.id }))
    .some(entry => /landed as .*cleanup failed.*work discard/.test(entry.line)),
  'the separate cleanup failure survives in the durable Loop log');

  const discarded = await api.invoke('work:discard', {
    projectId, taskId: task.id, attemptId: wt.attemptId,
  });
  assert.equal(discarded.outcome, 'removed');
  assert.equal((await api.invoke('task:get', { projectId, id: task.id })).status, 'landed',
    'cleanup cannot turn a merged task back into work');
  const ready = await api.invoke('task:ready', { projectId });
  assert.equal(ready.ready.some(candidate => candidate.id === task.id), false);
  assert.doesNotMatch(await api.invoke('loop:report', { projectId }),
    new RegExp(`${task.id}.*queued`, 'i'));
});

// --- INVARIANT: an empty diff is refused even if everything upstream passed --

test('WR-07/6: landing independently refuses an empty diff', async () => {
  const { api, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot, 'empty-subject');
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await api.invoke('task:add', { projectId, title: 'Change nothing', body: 'Deliberately produce no diff.' });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  // The agent "finished" and touched nothing — defense in depth behind the
  // executor's own effect check.
  setScript(() => JSON.stringify({ verdict: 'approve', reason: 'Looks fine to me.' }));

  const landed = await api.invoke('work:land', {
    projectId, taskId: task.id, attemptId: wt.attemptId,
    reviewer: { provider: 'script', model: 'reviewer' }
  });
  assert.equal(landed.landed, false,
    'INVARIANT VIOLATED: an empty diff was landed');
  assert.match(String(landed.stage ?? '') + String(landed.guidance ?? ''), /empty|no.?change|nothing/i);
});

// --- INVARIANT: Settings priority is the priority that runs ------------------

test('WR-07/7: reordering providers in Settings moves the next unpinned node', () => {
  const { engine } = harness();
  engine.settings.providers = { anthropic: { apiKey: 'k' }, openrouter: { apiKey: 'k' } };
  const codeNode = { type: 'agentTask', data: { role: 'execute', category: 'Code general' } };

  engine.settings.providerPriority = ['anthropic', 'openrouter'];
  engine.rebuildRuntimeConfig();
  const first = resolveWorkerRoute(codeNode, engine.runtimeConfig);
  assert.equal(first.worker.provider, 'anthropic');

  // The user drags OpenRouter to the top. No restart.
  engine.settings.providerPriority = ['openrouter', 'anthropic'];
  engine.rebuildRuntimeConfig();
  const second = resolveWorkerRoute(codeNode, engine.runtimeConfig);
  assert.equal(second.worker.provider, 'openrouter',
    'INVARIANT VIOLATED: the Settings order was ignored by default worker selection');
  assert.equal(second.via, 'settings-priority');

  // A pin is still a pin, whatever the order says.
  const pinned = resolveWorkerRoute(
    { type: 'agentTask', data: { worker: { provider: 'anthropic', model: 'claude-sonnet-5' } } },
    engine.runtimeConfig);
  assert.equal(pinned.worker.provider, 'anthropic');
  assert.equal(pinned.via, 'node');
});

// --- INVARIANT: a reviewer that could not judge is not a task that failed ----

test('WR-07/8: a reviewer with no usable verdict costs the task no band', async () => {
  // Watched it in a live loop:
  //
  //   ✖ t-0076 review: The reviewer returned no usable verdict block.
  //   ▶ t-0076 … on deepseek/deepseek-v4-pro-0813 (band high)
  //
  // A band bought with a reviewer's malformed answer. The dearer model then
  // produces the same diff, for a reviewer that may garble it again.
  const { api, dataRoot } = harness();
  const repo = await scenarioRepo(dataRoot, 'review-subject');
  const { id: projectId } = await api.invoke('project:open', { folder: repo });
  await api.invoke('task:add', {
    projectId, title: 'Add the banner', body: 'Add a banner to app.js.', level: 'medium'
  });
  const { tasks: [task] } = await api.invoke('task:list', { projectId });

  const wt = await api.invoke('work:start', { projectId, taskId: task.id });
  fs.writeFileSync(path.join(wt.dir, 'app.js'), 'export const banner = "v1";\n');
  assert.equal((await api.invoke('work:verify', { projectId, taskId: task.id })).ok, true);

  // The reviewer answers with prose the parser cannot read — which is what a
  // cheap reviewer does under load, and is not an opinion about the diff.
  setScript(() => 'I think this looks broadly reasonable but I am not going to say so in a block.');

  const landed = await api.invoke('work:land', {
    projectId, taskId: task.id, attemptId: wt.attemptId,
    reviewer: { provider: 'script', model: 'reviewer' }
  });
  assert.equal(landed.landed, false);
  assert.equal(landed.stage, 'review');
  assert.equal(landed.review.unavailable, true, 'the review says it could not judge, not that it objected');

  const after = await api.invoke('task:get', { projectId, id: task.id });
  assert.equal(after.level, 'medium', 'INVARIANT VIOLATED: the reviewer failing moved the task up a band');
  assert.equal(after.status, 'queued', 'and it is back in the queue rather than parked');
  assert.equal(after.attempts, 1, 'the attempt still counts, so a review that never works reaches a person');
  assert.match(after.blockedReason, /could not judge/);
});
