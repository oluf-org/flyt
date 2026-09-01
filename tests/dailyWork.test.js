import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { fileURLToPath } from 'node:url';
import {
  initialFlowId, normalizeBlockStatus, stackFromSnapshot, watchingFromRun,
} from '../src/v2/dailyWorkModel.js';
import { runView } from '../src/v2/runView.js';
import { traceView } from '../src/v2/traceView.js';
import { INITIAL, MODELS } from '../src/v2/shellRouting.js';
import {
  DAILY_PROJECT_ACTIONS, applyDailyRunUpdate, dailyProjectBridge, subscribeDailyRun,
} from '../src/v2/dailyWorkBridge.js';

const snapshot = {
  meta: {
    flowId: 'quick-fix', flowName: 'Quick fix', stage: 'execution',
    nodeStatus: { input: 'done', fix: 'active', output: 'pending' },
    createdAt: '2026-08-28T05:00:00.000Z', updatedAt: '2026-08-28T05:00:02.000Z',
  },
  flow: {
    id: 'quick-fix', name: 'Quick fix',
    nodes: [
      { id: 'input', type: 'input', data: {} },
      { id: 'fix', type: 'agentTask', data: { title: 'Fix it', taskId: 'task-1' } },
      { id: 'output', type: 'output', data: {} },
    ],
  },
  taskOutputs: { 'task-1': 'Reading the failing test.' },
};

test('the daily run adapter draws a legacy run as a read-only canonical sequence', () => {
  const stack = stackFromSnapshot(snapshot);
  assert.equal(stack.id, 'quick-fix');
  assert.deepEqual(stack.root.children.map(node => node.id), ['fix']);
  assert.equal(stack.root.children[0].kind, 'block');
  assert.equal(stack.root.children[0].title, 'Fix it');
});

test('Work and Trace receive one folded source with live output and model metrics', () => {
  const watching = watchingFromRun('r-1', snapshot, [{
    event: 'model_call', node: 'fix', model: 'creator/model', ok: true,
    content: 'I found the cause.', finishReason: 'stop',
    usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.004 },
    at: '2026-08-28T05:00:01.000Z',
  }]);
  const work = runView(watching.trace);
  const trace = traceView(watching.trace);
  assert.equal(work.running, true);
  assert.equal(work.blocks.fix.status, 'active');
  assert.equal(work.blocks.fix.showing, 'I found the cause.',
    'a live model response is fresher than the last persisted task output');
  assert.equal(trace.turns[0].blockId, 'fix');
  assert.equal(trace.turns[0].costUsd, 0.004);
  assert.equal(trace.turns[0].steps[0].request.tokens, '120 in · 30 out');
});

test('daily selection restores a saved runnable flow and falls back safely', () => {
  const flows = [{ id: 'one' }, { id: 'two' }];
  assert.equal(initialFlowId(flows, 'two'), 'two');
  assert.equal(initialFlowId(flows, 'gone'), 'one');
  assert.equal(initialFlowId([], 'gone'), null);
  assert.equal(normalizeBlockStatus('complete'), 'done');
  assert.equal(normalizeBlockStatus('streaming'), 'active');
  assert.equal(normalizeBlockStatus('interrupted'), 'failed');
});

test('the production preload and browser mock both expose every daily-host seam', () => {
  const read = relative => fs.readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
  const preload = read('electron/preload.cjs');
  const mock = read('src/devMock.js');
  const methods = [
    'listProjects', 'openProject', 'createProject', 'renameProject', 'adoptProject',
    'revealProject', 'closeProject', 'activateProject', 'reorderProjects',
    'projectRecents', 'removeProjectRecent', 'pickProjectFolder', 'listFlows',
    'listConfigs', 'runWorkflow', 'listRuns', 'getSnapshot',
    'readRunLog', 'getSettings', 'listModels', 'modelRankings', 'setSettings',
    'saveProjectState',
  ];
  for (const method of methods) {
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} must cross Electron IPC`);
    assert.match(mock, new RegExp(`\\b${method}:`), `${method} must work in the browser harness`);
  }
});

test('the rendered shell keeps the composer and tabs on Work and opens Models in one hop', async () => {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
  const { default: Shell } = await vite.ssrLoadModule('/src/v2/Shell.jsx');
  const props = {
    composer: React.createElement('form', { 'data-daily-composer': true }, 'Prompt'),
    projectTabs: React.createElement('div', { 'data-project-tabs': true }, 'Project tabs'),
    models: React.createElement('main', { 'data-model-catalog': true }, 'Catalog metrics'),
  };
  try {
    const work = renderToStaticMarkup(React.createElement(Shell, { ...props, location: INITIAL }));
    assert.match(work, /data-daily-composer="true"/);
    assert.match(work, /data-project-tabs="true"/);
    // Every destination is one press away from every other, from the rail —
    // which is why the rail is rendered on Work rather than only where it is
    // pointing.
    for (const label of ['Work', 'Build', 'Library', 'Models']) {
      assert.match(work, new RegExp(`class="activity-label">${label}</span>`),
        `${label} has to be reachable without going anywhere first`);
    }
    assert.match(work, /class="activity-btn active"[^>]*aria-current="page"[^>]*Work/,
      'the rail says where you are, not only where you can go');
    assert.doesNotMatch(work, /data-model-catalog="true"/);

    const models = renderToStaticMarkup(React.createElement(Shell, {
      ...props, location: { dest: MODELS, run: null },
    }));
    assert.match(models, /data-model-catalog="true"/);
    assert.doesNotMatch(models, /data-daily-composer="true"/);

    // The Library is a destination of its own now, not a drawer inside Build.
    const library = renderToStaticMarkup(React.createElement(Shell, {
      ...props, location: { dest: 'library', run: null },
      build: { library: { plugins: [{ id: 'p', name: 'A plugin', specifier: 'x', builtin: false, state: 'active' }] } },
    }));
    assert.match(library, /Everything this project can use/);
    assert.match(library, /data-surface="library"/);
    assert.doesNotMatch(library, /data-daily-composer="true"/);
  } finally {
    await vite.close();
  }
});

test('every project tab action crosses the same behavior-tested bridge', async () => {
  const calls = [];
  const flyt = Object.fromEntries(DAILY_PROJECT_ACTIONS.map(name => [name, async (...args) => {
    calls.push([name, ...args]);
    return name;
  }]));
  const projects = dailyProjectBridge(flyt);
  await projects.openProject('C:/repo');
  await projects.createProject('First prompt');
  await projects.renameProject('p1', 'Renamed');
  await projects.adoptProject('p1', 'C:/repo');
  await projects.revealProject('p1');
  await projects.closeProject('p1');
  await projects.activateProject('p2');
  await projects.reorderProjects(['p2', 'p1']);
  assert.deepEqual(calls.map(call => call[0]), DAILY_PROJECT_ACTIONS);
  assert.deepEqual(calls.at(-1), ['reorderProjects', ['p2', 'p1']]);
});

test('live updates refresh only the run Work is actually following', async () => {
  let listener;
  let unsubscribed = false;
  const seen = [];
  const flyt = {
    onRunUpdate: fn => { listener = fn; return () => { unsubscribed = true; }; },
    getSnapshot: async () => snapshot,
    readRunLog: async () => [],
  };
  const unsubscribe = subscribeDailyRun(flyt, {
    getProjectId: () => 'p1', getRunId: () => 'run-1', onWatching: value => seen.push(value),
  });
  listener({ runId: 'some-other-run' });
  await Promise.resolve();
  assert.equal(seen.length, 0);
  listener({ runId: 'run-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(seen.at(-1).runId, 'run-1');
  unsubscribe();
  assert.equal(unsubscribed, true);
});

test('a legacy failure identifies its failed block even when its status marker is stale active', () => {
  const failed = watchingFromRun('r-failed', {
    ...snapshot,
    meta: { ...snapshot.meta, stage: 'failed', error: 'Fix failed', nodeStatus: { fix: 'active' } },
    retrospectives: { fix: { status: 'failed', error: 'provider exited' } },
  }, []);
  const view = runView(failed.trace);
  assert.equal(view.running, false);
  assert.equal(view.blocks.fix.status, 'failed');
  assert.equal(view.errorBlockId, 'fix');
});

test('canonical event and snapshot deltas update Work without rereading the run', async () => {
  const canonical = watchingFromRun('run-1', { ...snapshot, rev: 4 }, [
    { seq: 1, at: 't1', type: 'run.created', data: { runId: 'run-1' } },
    { seq: 2, at: 't2', type: 'turn.start', data: { runId: 'run-1', turn: 1, blockId: 'fix' } },
    { seq: 3, at: 't3', type: 'step.start', data: { runId: 'run-1', blockId: 'fix', step: 1 } },
    { seq: 4, at: 't4', type: 'llm.request', data: { callId: 'c1', blockId: 'fix', model: 'fast' } },
  ]);
  const streamed = applyDailyRunUpdate(canonical, {
    runId: 'run-1', events: [{ seq: 5, at: 't5', type: 'llm.stream', data: { callId: 'c1', text: 'live' } }],
  });
  assert.equal(streamed.resync, false);
  assert.equal(streamed.watching.cursor, 5);
  assert.equal(traceView(streamed.watching.trace).turns[0].steps[0].request.content, 'live');

  const patched = applyDailyRunUpdate(streamed.watching, {
    runId: 'run-1', base: 4, rev: 5, patch: { meta: { ...snapshot.meta, stage: 'done' } },
  });
  assert.equal(patched.resync, false);
  assert.equal(patched.watching.snapshot.rev, 5);
  assert.equal(patched.watching.snapshot.meta.stage, 'done');

  const missed = applyDailyRunUpdate(patched.watching, {
    runId: 'run-1', events: [{ seq: 7, at: 't7', type: 'turn.end', data: {} }],
  });
  assert.equal(missed.resync, true, 'a sequence gap is repaired with one explicit resync');
});
