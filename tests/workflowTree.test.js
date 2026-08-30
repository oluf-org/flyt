import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedChildren, workflowBlockNodes, workflowNodes } from '../src/v2/workflowTree.js';

test('a generated task marker is not mistaken for an iterable child list', () => {
  const generatedTask = {
    id: 'dispatch.alpha', kind: 'block', use: 'flyt-blocks-task-graph:worker', generated: true,
  };
  const root = {
    id: 'fable', kind: 'sequence', children: [
      { id: 'refiner', kind: 'block', use: 'flyt-blocks-core:prompt-refiner' },
      { id: 'dispatch', kind: 'block', use: 'flyt-blocks-task-graph:dispatch', generated: [generatedTask] },
    ],
  };

  assert.deepEqual(generatedChildren(generatedTask), []);
  assert.deepEqual(workflowNodes(root).map(node => node.id),
    ['fable', 'refiner', 'dispatch', 'dispatch.alpha']);
  assert.deepEqual(workflowBlockNodes(root).map(node => node.id),
    ['refiner', 'dispatch', 'dispatch.alpha']);
});

test('malformed collection fields cannot crash a workflow traversal', () => {
  assert.deepEqual(workflowNodes({ id: 'root', kind: 'sequence', children: true }).map(node => node.id), ['root']);
  assert.deepEqual(workflowNodes({ id: 'branch', kind: 'if', children: false, else: true }).map(node => node.id), ['branch']);
});
