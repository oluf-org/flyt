import test from 'node:test';
import assert from 'node:assert/strict';
import { generatedChildren, generatedTaskWaves, workflowBlockNodes, workflowNodes } from '../src/v2/workflowTree.js';

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

test('generated tasks are grouped into bounded dependency waves', () => {
  const tasks = [
    { id: 'dispatch.research', taskId: 'research', dependsOn: [] },
    { id: 'dispatch.design', taskId: 'design', dependsOn: [] },
    { id: 'dispatch.build', taskId: 'build', dependsOn: ['research', 'design'] },
    { id: 'dispatch.review', taskId: 'review', dependsOn: ['research', 'design'] },
  ];

  assert.deepEqual(generatedTaskWaves(tasks, { maxParallel: 2 }).map(wave => wave.map(task => task.taskId)), [
    ['research', 'design'], ['build', 'review'],
  ]);
});

test('generated task waves use the runtime parallelism default and retain malformed history', () => {
  const independent = Array.from({ length: 5 }, (_, index) => ({ id: `dispatch.task-${index}`, dependsOn: [] }));
  assert.deepEqual(generatedTaskWaves(independent).map(wave => wave.length), [4, 1]);

  const cyclic = [
    { id: 'dispatch.a', taskId: 'a', dependsOn: ['b'] },
    { id: 'dispatch.b', taskId: 'b', dependsOn: ['a'] },
  ];
  assert.deepEqual(generatedTaskWaves(cyclic, { maxParallel: 1 }).flat().map(task => task.taskId), ['a', 'b']);
});
