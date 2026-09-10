import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effortCopy, modelForWorkflow, workflowOutcome, workflowSteps,
} from '../src/v2/workflowUx.js';
import { desktopWorkflowCeiling } from '../core/kernelHost.js';

const pipeline = {
  id: 'pipeline',
  steps: [
    { id: 'refine', title: 'Refine', use: 'flyt-blocks-judgement:prompt-refiner', effort: null },
    { id: 'plan', title: 'Plan', use: 'flyt-blocks-loop:backlog-plan', effort: 'high' },
    { id: 'work', title: 'Work', use: 'flyt-blocks-core:work', effort: 'medium' },
  ],
  presets: [{ id: 'low', name: 'Low', overrides: { plan: { effort: 'low' }, work: { effort: 'low' } } }],
};

test('the workflow preview separates reasoning effort from model selection', () => {
  assert.deepEqual(workflowSteps(pipeline, 'low').map(step => step.effort), [null, 'low', 'low']);
  assert.match(effortCopy.low, /not the model/i);
  assert.deepEqual(modelForWorkflow({ provider: 'openai', model: 'gpt-5' }), {
    label: 'gpt-5', detail: 'Model-backed steps use openai unless a step override replaces it.',
  });
  assert.match(workflowOutcome(pipeline), /changes the project/i);
});

test('an attended workflow cannot write to the Loop queue', () => {
  const ceiling = desktopWorkflowCeiling([
    { ceiling: ['read_file', 'enqueue_task', 'write_file'] },
    { ceiling: ['create_task', 'update_task', 'read_file'] },
  ]);
  assert.deepEqual(ceiling.sort(), ['read_file', 'write_file']);
});
