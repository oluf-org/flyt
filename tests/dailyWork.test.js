import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  initialFlowId, normalizeBlockStatus, stackFromSnapshot, watchingFromRun,
} from '../src/v2/dailyWorkModel.js';
import { runView } from '../src/v2/runView.js';
import { traceView } from '../src/v2/traceView.js';

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
  ];
  for (const method of methods) {
    assert.match(preload, new RegExp(`\\b${method}:`), `${method} must cross Electron IPC`);
    assert.match(mock, new RegExp(`\\b${method}:`), `${method} must work in the browser harness`);
  }
});
