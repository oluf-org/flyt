import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { boundedSemanticContext, summarizeWorkflowRun } from '../core/conversationSupervisor.js';
import { parseStack } from '#kernel';

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const waitForAsync = async (predicate, label) => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};

async function workflowHarness(call) {
  const dataRoot = tmp('flyt-workflow-data-');
  const workspace = tmp('flyt-workflow-work-');
  const events = [];
  const engine = createEngine({
    projectRoot, dataRoot, userDataDir: dataRoot,
    emit: (type, payload) => events.push({ type, payload }),
  });
  engine.settings.workers = {
    ...engine.settings.workers,
    executor: { provider: 'script', model: 'workflow-model' },
    supervisor: { provider: null, model: null },
  };
  engine.settings.workflowModelTiers = {
    ...engine.settings.workflowModelTiers,
    free: [{ provider: 'script', model: 'workflow-model' }],
  };
  engine.settings.activeModels = [];
  engine.rebuildRuntimeConfig();
  engine.resolveModelSource = model => ({ provider: 'script', model });
  engine.kernelCallModel = call;
  const api = createApi(engine);
  const { id: projectId } = await api.invoke('project:open', { folder: workspace });
  return { api, engine, events, projectId, workspace, dataRoot };
}

async function approveRefinement(api, projectId, runId) {
  const pending = await waitForAsync(async () => {
    const rows = await api.invoke('workflow:pending', { projectId, runId });
    return rows.find(row => row.kind === 'question' && row.blockId === 'approve-refinement') ?? null;
  }, 'refined request checkpoint');
  await api.invoke('workflow:answer', {
    projectId, runId, questionId: pending.questionId, answer: 'Approve and continue',
  });
}

test('the Workflow picker exposes launchable stacks and their named modes', async () => {
  const { api } = await workflowHarness(async request => ({
    text: 'done', finishReason: 'stop', provider: 'script', model: request.model,
  }));
  const workflows = await api.invoke('workflow:list');
  assert.deepEqual(workflows.map(item => item.id).sort(), ['fable-at-home', 'learn-from-repo', 'pipeline', 'research', 'spec-an-idea']);
  assert.deepEqual(workflows.find(item => item.id === 'pipeline').presets.map(item => item.id), [
    'low', 'medium', 'high',
  ]);
  const pipeline = workflows.find(item => item.id === 'pipeline');
  assert.deepEqual(pipeline.steps.map(step => step.id), ['refine', 'approve-refinement', 'plan', 'work']);
  assert.deepEqual(pipeline.steps.map(step => step.modelTier), ['free', null, 'frontier', 'standard']);
  assert.equal(pipeline.steps.find(step => step.id === 'approve-refinement').checkpoint, true);
  assert.equal(pipeline.presets.find(item => item.id === 'low').overrides.work.effort, 'low');
  const fable = workflows.find(item => item.id === 'fable-at-home');
  assert.deepEqual(fable.presets.map(item => item.id), ['no', 'low', 'medium', 'high']);
  assert.deepEqual(fable.steps.map(step => step.id), ['prompt-refiner', 'dispatch']);
  const fableDispatch = fable.steps.find(step => step.id === 'dispatch');
  assert.equal(fableDispatch.use, 'flyt-blocks-core:task-graph');
  assert.equal(fable.presets.find(item => item.id === 'high').overrides.dispatch.parallelism, 'high');
  assert.equal(workflows.some(item => item.id === 'loop-task'), false, 'system Loop stack is not launchable chat UI');
});

test('Fable gives its planner and generated workers standing system prompts', () => {
  const source = fs.readFileSync(path.join(projectRoot, 'stacks', 'fable-at-home.stack.yaml'), 'utf8');
  const stack = parseStack(source, 'fable-at-home');
  const dispatch = stack.root.children.find(node => node.id === 'dispatch');
  assert.match(dispatch.config.systemPrompt, /dependency graph of tasks/);
  assert.match(dispatch.config.workerSystemPrompt, /Complete the assigned task/);
});

test('Fable materializes and completes its generated task blocks through the workflow API', async () => {
  let call = 0;
  const plan = JSON.stringify({
    summary: 'Two independent tasks.',
    tasks: [
      { id: 'alpha', title: 'Alpha', goal: 'Complete alpha.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] },
      { id: 'beta', title: 'Beta', goal: 'Complete beta.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] },
    ],
  });
  const { api, projectId } = await workflowHarness(async request => {
    call += 1;
    const text = call === 1 ? 'A clear refined goal.' : call === 2 ? plan : `completed worker ${call - 2}`;
    return { text, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'fable-at-home', input: 'Build both parts.', presetId: 'high', approvalMode: 'always',
  });
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'Fable generated task graph');

  assert.equal(snapshot.meta.presetId, 'high');
  assert.equal(snapshot.meta.nodeStatus['dispatch.alpha'], 'done');
  assert.equal(snapshot.meta.nodeStatus['dispatch.beta'], 'done');
  const dispatch = snapshot.stack.root.children.find(node => node.id === 'dispatch');
  assert.deepEqual(dispatch.generated.map(node => node.id), ['dispatch.alpha', 'dispatch.beta']);
  assert.match(snapshot.nodeOutputs.dispatch, /completed worker 1/);
  assert.match(snapshot.nodeOutputs.dispatch, /completed worker 2/);
});

test('a failed Fable planner can restart only dispatch and keep the completed refiner', async () => {
  let call = 0;
  const seen = [];
  const plan = JSON.stringify({
    summary: 'Recovered plan.',
    tasks: [{ id: 'finish', title: 'Finish', goal: 'Finish after the recovered plan.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] }],
  });
  const { api, projectId } = await workflowHarness(async request => {
    call += 1; seen.push(request);
    if (call === 1) return { text: 'A refined brief.', finishReason: 'stop', provider: 'script', model: request.model };
    if (call >= 2 && call <= 5) return {
      text: '', reasoning: 'analysis consumed the whole response', finishReason: 'length',
      usage: { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: call === 2 ? 4069 : 4094 } },
      provider: 'script', model: request.model,
    };
    return { text: call === 6 ? plan : 'Recovered worker finished.', finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'fable-at-home', input: 'Build the feature.', presetId: 'medium', approvalMode: 'always',
  });
  const failed = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'failed' ? current : null;
  }, 'Fable planner with no visible JSON');
  assert.match(failed.meta.error, /81,920-token ceiling/);
  assert.match(failed.meta.error, /4094 of 4096 completion tokens/);
  assert.deepEqual(seen.slice(1, 5).map(request => request.maxTokens), [61_440, 81_920, 81_920, 81_920]);

  await api.invoke('run:restartBlock', { projectId, runId: started.runId, blockId: 'dispatch' });
  const recovered = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'restarted Fable dispatch');
  assert.equal(call, 7, 'the refiner stayed completed; only planning and its generated worker reran');
  assert.equal(recovered.meta.nodeStatus['prompt-refiner'], 'done');
  assert.equal(recovered.meta.nodeStatus.dispatch, 'done');
  assert.match(recovered.nodeOutputs.dispatch, /Recovered worker finished/);
  const log = await api.invoke('run:log', { projectId, runId: started.runId });
  assert.ok(log.some(event => event.type === 'block.status' && event.data?.blockId === 'dispatch' && event.data?.status === 'pending'));
  assert.ok(log.some(event => event.type === 'run.stage' && event.data?.stage === 'resumed'));
});

test('a prose question from Fable refiner is parked for the user and never reaches its planner', async () => {
  let call = 0;
  const seen = [];
  const plan = JSON.stringify({
    summary: 'One task.',
    tasks: [{ id: 'review', title: 'Review', goal: 'Return the requested review.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] }],
  });
  const { api, projectId } = await workflowHarness(async request => {
    call += 1; seen.push(request);
    const text = call === 1 ? 'Which output format should I use?'
      : call === 2 ? 'Produce a Markdown review with explicit acceptance criteria.'
        : call === 3 ? plan : 'Completed the Markdown review.';
    return { text, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'fable-at-home', input: 'Prepare the review.', presetId: 'low', approvalMode: 'ask',
  });
  const pending = await waitForAsync(async () => {
    const rows = await api.invoke('workflow:pending', { projectId, runId: started.runId });
    return rows.find(row => row.kind === 'question' && row.blockId === 'prompt-refiner') ?? null;
  }, 'intercepted refiner question');
  assert.equal(pending.question, 'Which output format should I use?');
  assert.equal(call, 1, 'the planner was not called with the unanswered question');

  await api.invoke('workflow:answer', {
    projectId, runId: started.runId, questionId: pending.questionId, answer: 'Markdown',
  });
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'Fable after refiner answer');
  assert.match(snapshot.nodeOutputs['prompt-refiner'], /Markdown review/);
  assert.match(snapshot.nodeOutputs.dispatch, /Completed the Markdown review/);
  assert.match(JSON.stringify(seen[2].messages), /Markdown review/, 'only the settled brief reached planning');
});

test('Fable refuses refiner meta-questions without bothering the user or planner', async () => {
  let call = 0;
  const plan = JSON.stringify({
    summary: 'One focused task.',
    tasks: [{ id: 'inspect', title: 'Inspect', goal: 'Inspect the bound workspace.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] }],
  });
  const { api, events, projectId } = await workflowHarness(async request => {
    call += 1;
    if (call === 1) return {
      text: '', finishReason: 'tool_calls', provider: 'script', model: request.model,
      message: { tool_calls: [{ id: 'meta-question', function: {
        name: 'ask_human', arguments: JSON.stringify({ question: 'I do not have a file-reading tool. Could you provide the contents of package.json?' }),
      } }] },
    };
    const text = call === 2 ? 'Inspect the current bound workspace and return the requested evidence.'
      : call === 3 ? plan : 'Inspection complete.';
    return { text, finishReason: 'stop', provider: 'script', model: request.model };
  });

  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'fable-at-home', input: 'Inspect this repository.', presetId: 'low', approvalMode: 'ask',
  });
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'Fable after refusing a meta-question');

  assert.equal(events.some(event => event.type === 'workflow:event' && event.payload.kind === 'question'), false);
  assert.match(snapshot.nodeOutputs['prompt-refiner'], /bound workspace/);
  assert.match(snapshot.nodeOutputs.dispatch, /Inspection complete/);
  const log = await api.invoke('run:log', { projectId, runId: started.runId });
  assert.match(log.find(event => event.type === 'tool.result' && event.data?.callId === 'meta-question')?.data?.error ?? '', /refused by this block/);
});

test('Fable degrades to the original request when a Free refiner never finishes questioning', async () => {
  let call = 0;
  const plan = JSON.stringify({
    summary: 'Fallback task.',
    tasks: [{ id: 'finish', title: 'Finish', goal: 'Use the preserved request.', dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [] }],
  });
  const { api, projectId } = await workflowHarness(async request => {
    call += 1;
    if (call <= 4) return {
      text: '', finishReason: 'tool_calls', provider: 'script', model: request.model,
      message: { tool_calls: [{ id: `ask-${call}`, function: {
        name: 'ask_human', arguments: JSON.stringify({ question: `Question ${call}?` }),
      } }] },
    };
    return { text: call === 5 ? plan : 'Finished from the preserved request.', finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'fable-at-home', input: 'Preserve this exact request.', presetId: 'low', approvalMode: 'ask',
  });
  const pending = await waitForAsync(async () => {
    const rows = await api.invoke('workflow:pending', { projectId, runId: started.runId });
    return rows.find(row => row.kind === 'question') ?? null;
  }, 'one bounded refiner question');
  await api.invoke('workflow:answer', {
    projectId, runId: started.runId, questionId: pending.questionId, answer: 'Use the bound workspace.',
  });
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'deterministically degraded refiner');
  assert.match(snapshot.nodeOutputs['prompt-refiner'], /Preserve this exact request/);
  assert.match(snapshot.nodeOutputs['prompt-refiner'], /prompt refiner did not produce a usable final brief/i);
  assert.match(snapshot.nodeOutputs.dispatch, /Finished from the preserved request/);
  const log = await api.invoke('run:log', { projectId, runId: started.runId });
  assert.equal(log.filter(event => event.type === 'block.warning' && event.data?.code === 'refiner_degraded').length, 1);
  assert.equal(call, 6, 'one question plus bounded refusals, then planning and work');
});

test('a Pipeline run pins every leaf, records the preset, and ends with a fallback chat summary', async () => {
  const seen = [];
  const { api, projectId } = await workflowHarness(async request => {
    seen.push(request);
    return { text: `result ${seen.length}`, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Do the requested work.', presetId: 'low', approvalMode: 'always',
  });
  await approveRefinement(api, projectId, started.runId);
  const snapshot = await waitForAsync(async () => {
    try {
      const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
      return current.meta.stage === 'done' && current.conversation.some(turn => turn.supervisor) ? current : null;
    } catch { return null; }
  }, 'terminal workflow summary');

  assert.equal(snapshot.meta.presetId, 'low');
  assert.ok(seen.length >= 3, 'every Pipeline leaf called the model');
  assert.ok(seen.every(request => request.model === 'workflow-model'));
  assert.ok(seen.some(request => /LOW effort/i.test(JSON.stringify(request))), 'preset override reached a model-backed leaf');
  const final = snapshot.conversation.at(-1);
  assert.equal(final.role, 'assistant');
  assert.equal(final.supervisor, true);
  assert.equal(final.degraded, true);
  assert.match(final.text, /workflow finished/i);
});

test('a launch with no mode named runs the default one, and records it', async () => {
  // A workflow that declares modes always runs in one of them. Before this,
  // an absent presetId ran the authored config — a fourth, unnamed way to run
  // Pipeline that no picker offered and no run record could name.
  const seen = [];
  const { api, projectId } = await workflowHarness(async request => {
    seen.push(request);
    return { text: `result ${seen.length}`, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'No mode named.', approvalMode: 'always',
  });
  await approveRefinement(api, projectId, started.runId);
  const snapshot = await waitForAsync(async () => {
    try {
      const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
      return current.meta.stage === 'done' ? current : null;
    } catch { return null; }
  }, 'default-mode workflow');
  assert.equal(snapshot.meta.presetId, 'medium',
    'the immutable record names the mode that was applied, not the null the caller sent');
  assert.ok(seen.some(request => /MEDIUM effort/i.test(JSON.stringify(request))),
    'and the default mode overrides actually reached a model-backed leaf');
});

test('authored workflow tiers resolve through the current global tier models', async () => {
  const seen = [];
  const { api, engine, projectId } = await workflowHarness(async request => {
    seen.push(request.model);
    return { text: `result ${seen.length}`, finishReason: 'stop', provider: 'script', model: request.model };
  });
  engine.settings.workflowModelTiers = {
    free: [{ provider: 'script', model: 'free-refiner' }],
    economy: { provider: 'script', model: 'economy-model' },
    standard: { provider: 'script', model: 'standard-worker' },
    frontier: { provider: 'script', model: 'frontier-planner' },
  };
  engine.rebuildRuntimeConfig();
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Use the authored efficient route.', presetId: 'medium',
  });
  await approveRefinement(api, projectId, started.runId);
  await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'authored tier workflow');
  assert.deepEqual(seen.slice(0, 3), ['free-refiner', 'frontier-planner', 'standard-worker']);
});

test('chat model choices use a default model with real per-step overrides', async () => {
  const seen = [];
  const { api, projectId } = await workflowHarness(async request => {
    seen.push(request.model);
    return { text: `result ${seen.length}`, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Use economical routing.', presetId: 'medium',
    modelSelection: {
      defaultWorker: { provider: 'script', model: 'balanced-model' },
      blocks: {
        refine: { provider: 'script', model: 'cheap-model' },
        work: { provider: 'script', model: 'strong-model' },
      },
    },
  });
  await approveRefinement(api, projectId, started.runId);
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'per-step model workflow');

  assert.deepEqual(seen.slice(0, 3), ['cheap-model', 'balanced-model', 'strong-model']);
  assert.equal(snapshot.meta.model, 'balanced-model');
  assert.equal(snapshot.meta.blockWorkers.refine.model, 'cheap-model');
  assert.equal(snapshot.meta.blockWorkers.work.model, 'strong-model');

  seen.length = 0;
  const followed = await api.invoke('workflow:reply', {
    projectId, runId: started.runId, text: 'Keep the same model split.',
  });
  await approveRefinement(api, projectId, followed.runId);
  await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: followed.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'follow-up with preserved per-step models');
  assert.deepEqual(seen.slice(0, 3), ['cheap-model', 'balanced-model', 'strong-model']);
});

test('a Free block falls through its configured free chain without using the paid default', async () => {
  const seen = [];
  const { api, projectId } = await workflowHarness(async request => {
    seen.push(request.model);
    if (request.model === 'free-primary') throw new Error('free capacity exhausted');
    return { text: `result ${seen.length}`, finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Use the free refining chain.', presetId: 'low',
    modelSelection: {
      defaultWorker: { provider: 'script', model: 'paid-default' },
      defaultFallbacks: [],
      blocks: { refine: { provider: 'script', model: 'free-primary' } },
      blockFallbacks: { refine: [{ provider: 'script', model: 'free-backup' }] },
    },
  });
  await approveRefinement(api, projectId, started.runId);
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'free fallback workflow');

  assert.deepEqual(seen.slice(0, 4), ['free-primary', 'free-backup', 'paid-default', 'paid-default']);
  assert.deepEqual(snapshot.meta.blockFallbacks.refine, [{ provider: 'script', model: 'free-backup' }]);
});

test('pending approval survives renderer reconnection and resolves directly without a supervisor turn', async () => {
  let modelCalls = 0;
  const { api, projectId, workspace } = await workflowHarness(async request => {
    modelCalls += 1;
    if (modelCalls === 3) {
      return {
        text: 'I need to write the file.', finishReason: 'tool_calls', provider: 'script', model: request.model,
        message: { tool_calls: [{
          id: 'write-one',
          function: { name: 'create_file', arguments: JSON.stringify({ path: 'made.txt', content: 'made\n' }) },
        }] },
      };
    }
    return { text: 'Handled the decision.', finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Try the operation.', presetId: 'low', approvalMode: 'ask',
  });
  await approveRefinement(api, projectId, started.runId);
  const pending = await waitForAsync(async () => {
    const rows = await api.invoke('workflow:pending', { projectId, runId: started.runId });
    return rows.length ? rows : null;
  }, 'pending workflow approval');
  assert.equal(pending[0].kind, 'approval');
  assert.equal(pending[0].tool, 'create_file');

  await api.invoke('workflow:decide', {
    projectId, runId: started.runId, callId: pending[0].callId, approved: false,
  });
  await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'workflow after direct approval decision');
  assert.equal(fs.existsSync(path.join(workspace, 'made.txt')), false);
  assert.equal((await api.invoke('workflow:pending', { projectId, runId: started.runId })).length, 0);
});

test('a block question bypasses approval and its answer returns straight to that block', async () => {
  let modelCalls = 0;
  const { api, events, projectId } = await workflowHarness(async request => {
    modelCalls += 1;
    if (modelCalls === 3) {
      return {
        text: 'I need the user choice.', finishReason: 'tool_calls', provider: 'script', model: request.model,
        message: { tool_calls: [{
          id: 'ask-one',
          function: { name: 'ask_human', arguments: JSON.stringify({
            question: 'Which format should I use?', options: ['Markdown', 'HTML'], context: 'Both are supported.',
          }) },
        }] },
      };
    }
    return { text: 'Used the direct answer.', finishReason: 'stop', provider: 'script', model: request.model };
  });
  const started = await api.invoke('workflow:run', {
    projectId, workflowId: 'pipeline', input: 'Prepare the result.', presetId: 'medium', approvalMode: 'ask',
  });
  await approveRefinement(api, projectId, started.runId);
  const pending = await waitForAsync(async () => {
    const rows = await api.invoke('workflow:pending', { projectId, runId: started.runId });
    return rows.length ? rows : null;
  }, 'direct block question');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, 'question');
  assert.equal(pending[0].question, 'Which format should I use?');
  assert.equal(events.some(event => event.type === 'workflow:event' && event.payload.kind === 'approval'), false);

  await api.invoke('workflow:answer', {
    projectId, runId: started.runId, questionId: pending[0].questionId, answer: 'Markdown',
  });
  const snapshot = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: started.runId });
    return current.meta.stage === 'done' ? current : null;
  }, 'workflow after direct block answer');
  assert.match(snapshot.nodeOutputs.work, /Used the direct answer/);
});

test('a general follow-up creates a linked immutable run with supervisor context', async () => {
  let calls = 0;
  const { api, projectId } = await workflowHarness(async request => ({
    text: `answer ${++calls}`, finishReason: 'stop', provider: 'script', model: request.model,
  }));
  const first = await api.invoke('workflow:run', {
    projectId, workflowId: 'research', input: 'Establish the first answer.', approvalMode: 'ask',
  });
  const before = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: first.runId });
    return current.conversation.some(turn => turn.supervisor) ? current : null;
  }, 'first terminal summary');
  const head = before.session.head;

  const second = await api.invoke('workflow:reply', {
    projectId, runId: first.runId, text: 'Now refine that answer.', approvalMode: 'ask',
  });
  const after = await waitForAsync(async () => {
    const current = await api.invoke('run:snapshot', { projectId, runId: second.runId });
    return current.conversation.some(turn => turn.supervisor) ? current : null;
  }, 'follow-up terminal summary');
  const original = await api.invoke('run:snapshot', { projectId, runId: first.runId });

  assert.notEqual(second.runId, first.runId);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(after.meta.parentRunId, first.runId);
  assert.equal(after.meta.conversationId, first.conversationId);
  assert.equal(after.meta.userMessage, 'Now refine that answer.');
  assert.match(after.prompt, /CONVERSATION CONTEXT FROM THE PREVIOUS IMMUTABLE RUN/);
  assert.match(after.prompt, /Now refine that answer/);
  assert.equal(original.session.head, head, 'starting a follow-up did not append to the completed run');
});

test('supervisor context keeps whole outputs and falls back when no cheap model exists', async () => {
  const context = boundedSemanticContext([
    { label: 'first', text: 'a'.repeat(30) },
    { label: 'second', text: 'b'.repeat(30) },
  ], 45);
  assert.doesNotMatch(context, /a{1,29}$/);
  assert.match(context, /second:\nb{30}/);

  const summary = await summarizeWorkflowRun({
    snapshot: {
      meta: { stage: 'failed', stackId: 'sample', nodeStatus: { one: 'done', two: 'failed' } },
      nodeOutputs: { one: 'kept in full' },
    },
  });
  assert.equal(summary.degraded, true);
  assert.match(summary.text, /Failed: two/);
  assert.match(summary.text, /kept in full/);
});
