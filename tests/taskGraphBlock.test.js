import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytTools, sessionJsonl, provideSeam,
  executeTaskGraph, parseTaskGraphPlan, taskGraphRepairPrompt,
} from '#kernel';
import { stackWithGeneratedTasks } from '../core/runProjection.js';

const contract = tasks => JSON.stringify({ summary: 'Generated plan.', tasks });
const task = (id, over = {}) => ({
  id, title: id.toUpperCase(), goal: `Finish ${id}.`, dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [], ...over,
});

test('task graph validation infers data edges and serializes declared write conflicts', () => {
  const parsed = parseTaskGraphPlan(contract([
    task('schema', { produces: ['schema-shape'], writeFiles: ['src/shared.js'] }),
    task('consumer', { requires: ['schema-shape'] }),
    task('other-writer', { writeFiles: ['SRC\\shared.js'] }),
  ]), { parallelism: 'high' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.tasks[1].dependsOn, ['schema'], 'required inputs create a producer edge');
  assert.deepEqual(parsed.plan.tasks[2].dependsOn, ['schema'], 'same-file writes never race, even in High');
});

test('No parallel work turns an otherwise independent plan into one chain', () => {
  const parsed = parseTaskGraphPlan(contract([task('one'), task('two'), task('three')]), { parallelism: 'no' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.plan.tasks.map(item => item.dependsOn), [[], ['one'], ['two']]);
});

test('invalid plans fail before materialization with actionable graph errors', () => {
  const parsed = parseTaskGraphPlan(contract([
    task('one', { dependsOn: ['two'], requires: ['missing-artifact'] }),
    task('two', { dependsOn: ['one'] }),
  ]));
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /requires "missing-artifact", but no task produces it/);
  assert.match(parsed.errors.join('\n'), /dependency cycle: one -> two -> one/);
});

test('planner repair feedback includes the rejected JSON and exact static diagnostics', () => {
  const invalid = contract([task('consumer', { requires: ['site-copy'] })]);
  const errors = ['consumer requires "site-copy", but no task produces it'];
  const prompt = taskGraphRepairPrompt(invalid, errors, 'Build a product page.', 2);
  assert.match(prompt, /REPAIR ATTEMPT 2/);
  assert.match(prompt, /consumer requires "site-copy", but no task produces it/);
  assert.ok(prompt.includes(invalid), 'the planner repairs its candidate instead of reconstructing it from a summary');
  assert.match(prompt, /Do not re-plan from scratch/);
});

test('a read-only brief rejects generated write scopes before any child runs', () => {
  const parsed = parseTaskGraphPlan(contract([
    task('analysis', { writeFiles: ['reports/analysis.md'] }),
  ]), { readOnly: true });
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /writeFiles must be empty because the brief is read-only/);
});

function fakeLlm(plan) {
  let calls = 0;
  let workers = 0;
  let peak = 0;
  const seen = [];
  return {
    get peak() { return peak; },
    seen,
    seam: {
      stream(request) {
        seen.push(request);
        const index = calls++;
        const content = index === 0 ? plan : `worker-${index} done`;
        if (index > 0) { workers += 1; peak = Math.max(peak, workers); }
        return {
          async *[Symbol.asyncIterator]() { yield { text: content }; },
          async settled() {
            if (index > 0) await new Promise(resolve => setTimeout(resolve, 15));
            if (index > 0) workers -= 1;
            return { content, finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } };
          },
        };
      },
      async complete() { throw new Error('stream only'); },
      async models() { return []; },
    },
  };
}

test('Plan & dispatch runs independent generated children together and records them durably', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-'));
  const kernel = createKernel();
  const llm = fakeLlm(contract([task('alpha'), task('beta', { writeFiles: ['out.txt'] })]));
  await kernel.ctx.plugin(flytTools);
  kernel.ctx.tools.register({
    name: 'peek', description: 'Read.', parameters: { type: 'object' },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { return { content: 'read' }; },
  });
  kernel.ctx.tools.register({
    name: 'write_it', description: 'Write.', parameters: { type: 'object' },
    classification: { effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { return { content: 'wrote' }; },
  });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'fake-llm', apply(ctx) { return provideSeam(ctx, 'llm', llm.seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'run-1', blockId: 'dispatch', input: 'Build it.', ceiling: ['peek', 'write_it'],
      config: {
        model: 'fake', parallelism: 'high', maxTasks: 4, maxParallel: 2, workerMaxSteps: 1,
        systemPrompt: 'CUSTOM PLANNER FOR THIS WORKFLOW',
        workerSystemPrompt: 'CUSTOM GENERATED WORKER FOR THIS WORKFLOW',
      },
    });
    assert.equal(outcome.status, 'done', outcome.error);
    assert.equal(llm.seen[0].maxTokens, 61_440,
      'the planner has answer room after a reasoning model thinks');
    assert.equal(llm.seen[0].temperature, 0.1);
    assert.ok(llm.seen.slice(1).every(request => request.maxTokens === 32_768),
      'generated workers get substantially more per-query output room');
    assert.equal(llm.peak, 2, 'both ready tasks ran in the same bounded wave');
    assert.equal(llm.seen[0].messages.find(message => message.role === 'system')?.content,
      'CUSTOM PLANNER FOR THIS WORKFLOW');
    assert.ok(llm.seen.slice(1).every(request => request.messages.find(message => message.role === 'system')?.content
      .startsWith('CUSTOM GENERATED WORKER FOR THIS WORKFLOW')),
    'the workflow override replaces the standing worker prompt, while workerInstructions still append');
    assert.deepEqual(llm.seen[1].tools.map(tool => tool.name), ['peek'],
      'a generated task declaring no writes never receives write tools');
    assert.deepEqual(llm.seen[2].tools.map(tool => tool.name), ['peek', 'write_it'],
      'a task declaring a write retains its authored ceiling');
    const workerPrompts = llm.seen.slice(1).map(request => request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n'));
    assert.match(workerPrompts[0], /# Task: ALPHA/);
    assert.doesNotMatch(workerPrompts[0], /# Task: BETA/, 'a parallel worker cannot see its sibling brief');
    assert.match(workerPrompts[1], /# Task: BETA/);
    assert.doesNotMatch(workerPrompts[1], /# Task: ALPHA/);

    const session = await kernel.ctx.sessions.read('run-1');
    const events = [];
    for await (const event of session.read()) events.push(event);
    const pending = events.filter(event => event.type === 'block.status' && event.data.status === 'pending');
    assert.deepEqual(pending.map(event => event.data.blockId), ['dispatch.alpha', 'dispatch.beta']);
    assert.ok(events.some(event => event.type === 'block.output' && event.data.blockId === 'dispatch' && event.data.port === 'plan'));
    assert.ok(events.some(event => event.type === 'block.output' && event.data.blockId === 'dispatch.alpha'));

    const displayed = stackWithGeneratedTasks({ kind: 'sequence', id: 'root', children: [
      { kind: 'block', id: 'dispatch', use: 'flyt-blocks-core:task-graph', title: 'Plan & dispatch', config: {} },
    ] }, events);
    assert.deepEqual(displayed.children[0].generated.map(child => child.id), ['dispatch.alpha', 'dispatch.beta']);
    assert.equal(displayed.children[0].generated[0].generated, true);
    assert.equal(displayed.children[0].generated[0].taskId, 'alpha');
  } finally {
    await kernel.dispose();
  }
});

test('Plan & dispatch reports every failed task in a parallel wave', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-failures-'));
  const kernel = createKernel();
  const plan = contract([task('theme-provider'), task('color-settings-ui')]);
  let calls = 0;
  const seam = {
    stream() {
      const index = calls++;
      if (index > 0) throw new Error(`worker ${index} provider failure`);
      return {
        async *[Symbol.asyncIterator]() { yield { text: plan }; },
        async settled() {
          return { content: plan, finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } };
        },
      };
    },
    async complete() { throw new Error('stream only'); },
    async models() { return []; },
  };
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'failing-workers', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'run-failures', blockId: 'dispatch', input: 'Build both.', ceiling: [],
      config: { model: 'fake', parallelism: 'high', maxParallel: 2 },
    });
    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error, /^2 generated tasks failed:/);
    assert.match(outcome.error, /"THEME-PROVIDER": worker 1 provider failure/);
    assert.match(outcome.error, /"COLOR-SETTINGS-UI": worker 2 provider failure/);
  } finally {
    await kernel.dispose();
  }
});

test('Plan & dispatch can repair more than one distinct static graph failure before materializing work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-repairs-'));
  const kernel = createKernel();
  const invalidArtifact = contract([task('consumer', { requires: ['copy'] })]);
  const invalidCycle = contract([
    task('one', { dependsOn: ['two'] }),
    task('two', { dependsOn: ['one'] }),
  ]);
  const valid = contract([task('finish')]);
  const answers = [invalidArtifact, invalidCycle, valid, 'worker finished'];
  const seen = [];
  let call = 0;
  const seam = {
    stream(request) {
      seen.push(request);
      const content = answers[call++];
      return {
        async *[Symbol.asyncIterator]() { yield { text: content }; },
        async settled() {
          return { content, finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } };
        },
      };
    },
    async complete() { throw new Error('stream only'); },
    async models() { return []; },
  };
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'repairing-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'repair-run', blockId: 'dispatch', input: 'Build it.', ceiling: [],
      config: { model: 'fake', maxTasks: 4 },
    });
    assert.equal(outcome.status, 'done', outcome.error);
    assert.equal(call, 4, 'two planner repairs were followed by exactly one generated worker');
    assert.match(seen[1].messages.at(-1).content, /requires "copy", but no task produces it/);
    assert.ok(seen[1].messages.at(-1).content.includes(invalidArtifact));
    assert.match(seen[2].messages.at(-1).content, /dependency cycle: one -> two -> one/);
    assert.ok(seen[2].messages.at(-1).content.includes(invalidCycle));
    const events = (await kernel.ctx.sessions.read('repair-run')).readSync();
    const warnings = events.filter(event => event.type === 'block.warning' && event.data.code === 'invalid_task_graph');
    assert.deepEqual(warnings.map(event => event.data.attempt), [1, 2]);
    assert.ok(warnings.every(event => Array.isArray(event.data.diagnostics) && event.data.diagnostics.length));
  } finally {
    await kernel.dispose();
  }
});

test('a reasoning-only planner uses all bounded repair attempts and fails with the real token diagnosis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-reasoning-'));
  const kernel = createKernel();
  const seen = [];
  const seam = {
    stream(request) {
      seen.push(request);
      const usage = seen.length === 1
        ? { promptTokens: 836, completionTokens: 4096, reasoningTokens: 4069, costUsd: 0.0022 }
        : { promptTokens: 860, completionTokens: 4096, reasoningTokens: 4094, costUsd: 0.0011 };
      return {
        async *[Symbol.asyncIterator]() { yield { reasoning: 'planning without an answer' }; },
        async settled() {
          return {
            content: '', reasoning: 'planning without an answer', finishReason: 'length', usage,
            route: { requested: 'fake', effective: 'fake', reason: '', degraded: false },
          };
        },
      };
    },
    async complete() { throw new Error('stream only'); },
    async models() { return []; },
  };
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'reasoning-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'reasoning-run', blockId: 'dispatch', input: 'Build it.', ceiling: [],
      config: { model: 'fake', maxTasks: 4 },
    });
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(seen.map(request => request.maxTokens), [61_440, 81_920, 81_920, 81_920]);
    assert.deepEqual(seen.map(request => request.temperature), [0.1, 0, 0, 0]);
    assert.match(outcome.error, /cut off at its 81,920-token ceiling/);
    assert.match(outcome.error, /4094 of 4096 completion tokens on internal reasoning/);
    assert.match(outcome.error, /Retry this block or choose another model/);
  } finally {
    await kernel.dispose();
  }
});
