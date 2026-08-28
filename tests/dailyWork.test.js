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
  DAILY_PROJECT_ACTIONS, dailyProjectBridge, launchDailyPrompt, subscribeDailyRun,
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
    'listConfigs', 'flowLaunchInputs', 'runFlow', 'listRuns', 'getSnapshot',
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
    assert.match(work, />Models<\/button>/);
    assert.doesNotMatch(work, /data-model-catalog="true"/);

    const models = renderToStaticMarkup(React.createElement(Shell, {
      ...props, location: { dest: MODELS, run: null },
    }));
    assert.match(models, /data-model-catalog="true"/);
    assert.doesNotMatch(models, /data-daily-composer="true"/);
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

test('a projectless prompt creates, remembers, launches and follows the run', async () => {
  const calls = [];
  const flyt = {
    createProject: async text => { calls.push(['createProject', text]); return { opened: 'appdata:first' }; },
    saveProjectState: async (...args) => calls.push(['saveProjectState', ...args]),
    runFlow: async (...args) => { calls.push(['runFlow', ...args]); return 'run-1'; },
    getSnapshot: async (...args) => { calls.push(['getSnapshot', ...args]); return snapshot; },
    readRunLog: async (...args) => { calls.push(['readRunLog', ...args]); return []; },
    listRuns: async (...args) => { calls.push(['listRuns', ...args]); return [{ id: 'run-1' }]; },
  };
  const result = await launchDailyPrompt({
    flyt, projectId: null, flowId: 'quick-fix', text: 'Fix the build',
    approvalMode: 'smart', modeId: 'careful', overrides: { fix: { effort: 'high' } },
    inputs: { repo: 'owner/repo' }, hasDeclaredInputs: true,
  });
  assert.equal(result.projectId, 'appdata:first');
  assert.equal(result.runId, 'run-1');
  assert.equal(result.watching.runId, 'run-1');
  assert.deepEqual(result.runs, [{ id: 'run-1' }]);
  assert.deepEqual(calls[1], ['saveProjectState', 'appdata:first', {
    runFlowId: 'quick-fix', runModeId: 'careful',
  }]);
  assert.deepEqual(calls[2], ['runFlow', 'appdata:first', 'quick-fix', 'Fix the build', null, 'smart', {
    modeId: 'careful', overrides: { fix: { effort: 'high' } }, inputs: { repo: 'owner/repo' },
  }]);
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
