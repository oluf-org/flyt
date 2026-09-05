import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytTools, sessionJsonl, provideSeam,
  executeTaskGraph, parseTaskGraphPlan, taskGraphRepairPrompt, childSessionIdentity,
} from '#kernel';
import { stackWithGeneratedTasks } from '../core/runProjection.js';

const contract = tasks => JSON.stringify({ summary: 'Generated plan.', tasks });
const task = (id, over = {}) => ({
  id, title: id.toUpperCase(), goal: `Finish ${id}.`, dependsOn: [], produces: [], requires: [], optional: [], writeFiles: [], ...over,
});

test('read-only stream recovery reuses completed reads and passes verified attempt counts at the join', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-read-recovery-'));
  const kernel = createKernel();
  t.after(async () => { await kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const plan = contract([task('read'), task('join', { dependsOn: ['read'] })]);
  let reads = 0;
  let call = 0;
  const seen = [];
  const answers = [
    { content: plan },
    { content: '', toolCalls: [{ id: 'read-once', name: 'peek', args: {} }] },
    null,
    { content: 'evidence retained' },
    { content: 'this synthesis is too long for the configured limit' },
    { content: 'bounded synthesis' },
  ];
  await kernel.ctx.plugin(flytTools);
  kernel.ctx.tools.register({ name: 'peek', description: 'Read', parameters: { type: 'object' },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { reads++; return { content: 'UNIQUE_READ_EVIDENCE' }; } });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'read-recovery-model', apply(ctx) { return provideSeam(ctx, 'llm', {
    stream(request) {
      seen.push(structuredClone(request.messages));
      const answer = answers[call++];
      if (!answer) {
        const error = Object.assign(new Error('truncated provider stream'), { failure: {
          code: 'stream_terminated', source: 'provider', retryable: true, userInitiated: false,
          visibleOutputProduced: false, durableWriteProduced: false,
        } });
        return { async *[Symbol.asyncIterator]() { throw error; }, async settled() { throw error; } };
      }
      return { async *[Symbol.asyncIterator]() {}, async settled() { return {
        ...answer, finishReason: answer.toolCalls ? 'tool_calls' : 'stop',
      }; } };
    }, async models() { return []; },
  }); } });
  const result = await executeTaskGraph({ ctx: kernel.ctx, runId: 'run', blockId: 'graph', input: 'Read only. Keep each answer below 4 words.',
    ceiling: ['peek'], config: { model: 'fake', taskAttempts: 2 } });
  assert.equal(result.status, 'done', result.error);
  assert.equal(reads, 1);
  assert.equal(call, 6);
  assert.ok(seen[3].some(m => m.role === 'tool' && m.content === 'UNIQUE_READ_EVIDENCE'));
  assert.match(JSON.stringify(seen[3]), /CONTINUE FROM COMPLETED READS/);
  assert.doesNotMatch(JSON.stringify(seen[4]), /UNIQUE_READ_EVIDENCE/);
  assert.match(JSON.stringify(seen[4]), /Recorded execution facts/);
  const joinInput = seen[4].find(m => m.role === 'user').content;
  assert.ok(joinInput.includes('"attempts":2'));
  assert.ok(joinInput.includes('"toolResults":{"peek":1}'));
  assert.ok(joinInput.includes('"otherConstraints":"unverified"'));
  const session = await kernel.ctx.sessions.read('run');
  const before = call;
  await executeTaskGraph({ ctx: kernel.ctx, runId: 'run', blockId: 'graph', input: 'same', ceiling: ['peek'], config: { model: 'fake' } });
  assert.equal(call, before, 'resume reuses completed graph outputs');
  const done = session.readSync().find(e => e.type === 'block.status' && e.data.taskId === 'join' && e.data.status === 'done');
  assert.equal(done.data.execution.outputWordLimitPassed, true);
});

test('repeated task graphs plan again and use fresh linked child transcripts', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-graph-iteration-'));
  const kernel = createKernel();
  t.after(async () => { await kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const seen = [];
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'iteration-model', apply(ctx) { return provideSeam(ctx, 'llm', {
    stream(request) {
      const index = seen.length;
      seen.push(structuredClone(request.messages));
      const content = index % 2 === 0 ? contract([task('same-id')]) : `artifact-${index}`;
      return { async *[Symbol.asyncIterator]() {}, async settled() { return { content, finishReason: 'stop' }; } };
    }, async models() { return []; },
  }); } });
  const session = await kernel.ctx.sessions.open('run');
  for (let i = 0; i < 2; i++) {
    const result = await executeTaskGraph({ ctx: kernel.ctx, runId: 'run', blockId: 'graph', input: `INPUT_${i}`, ceiling: [],
      context: { mode: 'block-input', after: await session.head(), executionId: `/repeat[${i}]/graph` }, config: { model: 'fake' } });
    assert.equal(result.status, 'done', result.error);
  }
  assert.equal(seen.length, 4);
  assert.doesNotMatch(JSON.stringify(seen[2]), /INPUT_0|artifact-1/);
  assert.doesNotMatch(JSON.stringify(seen[3]), /INPUT_0|artifact-1/);
  const childIds = new Set(session.readSync().filter(e => e.type === 'child.session').map(e => e.data.sessionId));
  assert.equal(childIds.size, 2);
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

test('a broad inventory bottleneck feeding downstream tasks is rejected before dispatch', () => {
  const parsed = parseTaskGraphPlan(contract([
    task('inventory-workflow-blocks', {
      title: 'Enumerate the complete workflow block library',
      goal: 'Inventory every block in the repository for later assessment.',
      produces: ['block-inventory'],
    }),
    task('assess-blocks', {
      goal: 'Assess the inventory.', dependsOn: ['inventory-workflow-blocks'], requires: ['block-inventory'],
    }),
    task('verify-blocks', {
      goal: 'Verify the inventory.', dependsOn: ['inventory-workflow-blocks'], requires: ['block-inventory'],
    }),
  ]));
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join('\n'), /broad inventory task feeding assess-blocks, verify-blocks/);
  assert.match(parsed.errors.join('\n'), /focused bounded tasks|targeted reads/);
});

test('a bounded inventory feeding one consolidation task is allowed', () => {
  const parsed = parseTaskGraphPlan(contract([
    task('sweep-half-a', {
      title: 'Enumerate every block in the bounded half-A partition',
      goal: 'Inventory all block files assigned to half A.',
      produces: ['half-a-findings'],
    }),
    task('consolidate', {
      goal: 'Merge the bounded findings.', dependsOn: ['sweep-half-a'], requires: ['half-a-findings'],
    }),
  ]));
  assert.equal(parsed.ok, true, parsed.errors?.join('\n'));
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
    const plannerPrompt = llm.seen[0].messages.find(message => message.role === 'system')?.content;
    assert.match(plannerPrompt, /ROLE: task-graph-planner/);
    assert.match(plannerPrompt, /Do not create a broad repository-inventory/);
    assert.match(plannerPrompt, /WORKFLOW-SPECIFIC PLANNING GUIDANCE:\nCUSTOM PLANNER FOR THIS WORKFLOW/);
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
    assert.ok(!events.some(event => event.data.code === 'task_graph_repaired'), 'a valid first plan was never repaired');
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

test('generated tasks retry twice, continue independent work, and block only dependants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-recovery-'));
  const kernel = createKernel();
  const plan = contract([
    task('unstable'),
    task('dependent', { dependsOn: ['unstable'] }),
    task('independent'),
  ]);
  const taskCalls = new Map();
  const seam = {
    stream(request) {
      const prompt = request.messages.map(message => message.content ?? '').join('\n');
      const id = prompt.includes('# Task: UNSTABLE') ? 'unstable'
        : prompt.includes('# Task: INDEPENDENT') ? 'independent'
          : prompt.includes('# Task: DEPENDENT') ? 'dependent' : 'planner';
      const count = (taskCalls.get(id) ?? 0) + 1;
      taskCalls.set(id, count);
      if (id === 'unstable') {
        const error = Object.assign(new Error('provider stream terminated'), { failure: {
          code: 'stream_terminated', source: 'provider', provider: 'openrouter', model: 'fake',
          retryable: true, userInitiated: false, visibleOutputProduced: false,
          reasoningOutputProduced: true, toolCallProduced: false, durableWriteProduced: false,
        } });
        return {
          async *[Symbol.asyncIterator]() { yield { reasoning: 'thinking' }; throw error; },
          async settled() { throw error; },
        };
      }
      const content = id === 'planner' ? plan : `${id} completed`;
      return {
        async *[Symbol.asyncIterator]() { yield { text: content }; },
        async settled() { return { content, finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } }; },
      };
    },
    async complete() { throw new Error('stream only'); }, async models() { return []; },
  };
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'recovery-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'recovery-run', blockId: 'dispatch', input: 'Audit it.', ceiling: [],
      config: { model: 'fake', maxParallel: 2, taskAttempts: 2 },
    });
    assert.equal(outcome.status, 'failed');
    assert.equal(taskCalls.get('unstable'), 2, 'the scheduler owns exactly two total attempts');
    assert.equal(taskCalls.get('independent'), 1, 'independent work continues despite the sibling failure');
    assert.equal(taskCalls.has('dependent'), false, 'a failed dependency is never executed');
    const events = (await kernel.ctx.sessions.read('recovery-run')).readSync();
    const latest = id => events.filter(event => event.type === 'block.status' && event.data.taskId === id).at(-1)?.data;
    assert.equal(latest('unstable').attempt, 2);
    assert.equal(latest('unstable').failure.code, 'stream_terminated');
    assert.equal(latest('dependent').status, 'blocked');
    assert.deepEqual(latest('dependent').blockedBy, ['unstable']);
    assert.equal(latest('independent').status, 'done');
  } finally { await kernel.dispose(); }
});

test('a write task resumes from its durable checkpoint instead of replaying the task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-write-resume-'));
  const kernel = createKernel();
  const plan = contract([task('writer', { writeFiles: ['out.txt'] })]);
  let modelCall = 0;
  const prompts = [];
  const seam = {
    stream(request) {
      modelCall += 1;
      prompts.push(request.messages.map(message => message.content ?? '').join('\n'));
      if (modelCall === 1) return {
        async *[Symbol.asyncIterator]() { yield { text: plan }; },
        async settled() { return { content: plan, finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } }; },
      };
      if (modelCall === 2) return {
        async *[Symbol.asyncIterator]() {},
        async settled() { return {
          content: '', finishReason: 'tool_calls',
          toolCalls: [{ id: 'write-1', name: 'write_it', args: {} }],
          route: { requested: 'fake', effective: 'fake', reason: '', degraded: false },
        }; },
      };
      if (modelCall === 3) {
        const error = Object.assign(new Error('stream ended'), { failure: {
          code: 'stream_terminated', source: 'provider', provider: 'openrouter', model: 'fake',
          retryable: true, userInitiated: false, visibleOutputProduced: false,
          reasoningOutputProduced: true, toolCallProduced: false, durableWriteProduced: false,
        } });
        return { async *[Symbol.asyncIterator]() { yield { reasoning: 'thinking' }; throw error; }, async settled() { throw error; } };
      }
      return {
        async *[Symbol.asyncIterator]() { yield { text: 'resumed and verified' }; },
        async settled() { return { content: 'resumed and verified', finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } }; },
      };
    },
    async complete() { throw new Error('stream only'); }, async models() { return []; },
  };
  await kernel.ctx.plugin(flytTools);
  kernel.ctx.tools.register({
    name: 'write_it', description: 'Write once.', parameters: { type: 'object' },
    classification: { effect: 'write', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { return { content: 'wrote durable state' }; },
  });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'write-resume-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'write-resume-run', blockId: 'dispatch', input: 'Build it.', ceiling: ['write_it'],
      config: { model: 'fake', taskAttempts: 2 },
    });
    assert.equal(outcome.status, 'done', outcome.error);
    assert.equal(modelCall, 4);
    assert.match(prompts[3], /RESUME FROM CHECKPOINT/);
    assert.match(prompts[3], /Do not replay completed writes/);
    const childRef = (await kernel.ctx.sessions.read('write-resume-run')).readSync()
      .find(event => event.type === 'child.session' && event.data.taskId === 'writer');
    const childEvents = (await kernel.ctx.sessions.read(childRef.data.sessionId)).readSync();
    assert.ok(childEvents.some(event => event.type === 'context.checkpoint' && event.data.durableWriteProduced === true));
  } finally { await kernel.dispose(); }
});

test('application restart resumes an active write task from its recorded checkpoint', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-restart-'));
  const kernel = createKernel();
  const plan = contract([task('writer', { writeFiles: ['out.txt'] })]);
  const seen = [];
  const seam = {
    stream(request) {
      seen.push(request.messages.map(message => message.content ?? '').join('\n'));
      return {
        async *[Symbol.asyncIterator]() { yield { text: 'continued after restart' }; },
        async settled() { return { content: 'continued after restart', finishReason: 'stop', route: { requested: 'fake', effective: 'fake', reason: '', degraded: false } }; },
      };
    },
    async complete() { throw new Error('stream only'); }, async models() { return []; },
  };
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'restart-llm', apply(ctx) { return provideSeam(ctx, 'llm', seam); } });
  const parent = await kernel.ctx.sessions.open('restart-run');
  await parent.append({ type: 'block.output', data: { blockId: 'dispatch', port: 'plan', content: plan } });
  const identity = childSessionIdentity({ parentRunId: 'restart-run', parentBlockId: 'dispatch', taskId: 'writer', profileId: 'default-work', contextBoundary: 'isolated' });
  await parent.append({ type: 'block.status', data: {
    blockId: 'dispatch.writer', parentId: 'dispatch', taskId: 'writer', title: 'WRITER',
    status: 'active', attempt: 1, maxAttempts: 2, sessionId: identity.sessionId,
  } });
  const child = await kernel.ctx.sessions.open(identity.sessionId);
  await child.append({ type: 'context.checkpoint', data: {
    blockId: 'worker', kind: 'durable-progress', durableWriteProduced: true,
    content: 'Checkpoint: out.txt was already written; verification remains.',
    lastDurableProgress: { tool: 'write_it', callId: 'write-1', atStep: 4 },
  } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'restart-run', blockId: 'dispatch', input: 'Build it.', ceiling: [],
      config: { model: 'fake', taskAttempts: 2 },
    });
    assert.equal(outcome.status, 'done', outcome.error);
    assert.equal(seen.length, 1, 'the accepted plan and first attempt are not replayed');
    assert.match(seen[0], /RESUME FROM CHECKPOINT/);
    assert.match(seen[0], /verification remains/);
  } finally { await kernel.dispose(); }
});

test('child session ids resolve to the launched run for anything a person answers', async () => {
  const { parentRunIdOf, isChildSessionId } = await import('#kernel');
  const child = childSessionIdentity({ parentRunId: 'run-9', parentBlockId: 'dispatch', taskId: 'alpha', profileId: 'default-work' });
  assert.equal(isChildSessionId(child.sessionId), true);
  assert.equal(parentRunIdOf(child.sessionId), 'run-9');
  assert.equal(isChildSessionId('run-9'), false);
  assert.equal(parentRunIdOf('run-9'), 'run-9');
  assert.equal(parentRunIdOf('2026-09-03T16-24-32-616Z-hq7k--child-0248a7bfe0d0e908'), '2026-09-03T16-24-32-616Z-hq7k');
});

/** A planner that answers once, then workers that call a tool for as long as it is offered. */
function toolHungryLlm(plan, { toolName = 'peek', finalAnswer = 'Partial deliverable with coverage limits.' } = {}) {
  const seen = [];
  let calls = 0;
  return {
    seen,
    seam: {
      stream(request) {
        seen.push(request);
        const index = calls++;
        const offered = (request.tools ?? []).map(tool => tool.name);
        const answer = index === 0
          ? { content: plan }
          : offered.includes(toolName)
            ? { content: '', toolCalls: [{ id: `call-${index}`, name: toolName, args: { at: index } }] }
            : { content: finalAnswer };
        return {
          async *[Symbol.asyncIterator]() { if (answer.content) yield { text: answer.content }; },
          async settled() {
            return {
              content: answer.content, ...(answer.toolCalls ? { toolCalls: answer.toolCalls } : {}),
              finishReason: answer.toolCalls ? 'tool_calls' : 'stop',
              route: { requested: 'fake', effective: 'fake', reason: '', degraded: false },
            };
          },
        };
      },
      async complete() { throw new Error('stream only'); },
      async models() { return []; },
    },
  };
}

test('a runaway generated worker is hard-bounded, keeps what it learned, and is not called a success', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-bound-'));
  const kernel = createKernel();
  const llm = toolHungryLlm(contract([task('inspect')]));
  let reads = 0;
  await kernel.ctx.plugin(flytTools);
  kernel.ctx.tools.register({
    name: 'peek', description: 'Read.', parameters: { type: 'object' },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { reads += 1; return { content: 'read' }; },
  });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'fake-llm', apply(ctx) { return provideSeam(ctx, 'llm', llm.seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'run-bound', blockId: 'dispatch', input: 'Inspect it.', ceiling: ['peek'],
      config: { model: 'fake', workerMaxSteps: 3 },
    });
    assert.equal(outcome.status, 'failed',
      'a worker that answered only because its tools were taken away did not succeed');
    assert.match(outcome.output, /Partial deliverable/,
      'and its write-up survives, because throwing the evidence away helps nobody');
    assert.match(outcome.error, /INSPECT/);
    assert.match(outcome.error, /tool-round bound/);
    assert.equal(reads, 3, 'the worker read exactly as many rounds as its bound allows');
    assert.equal(llm.seen.length, 5, 'one planner turn, three bounded rounds, one answer-only turn');
    assert.deepEqual(llm.seen.at(-1).tools ?? [], [], 'the wrap-up turn offers no tools');

    const identity = childSessionIdentity({ parentRunId: 'run-bound', parentBlockId: 'dispatch', taskId: 'inspect', profileId: 'default-work' });
    const child = await kernel.ctx.sessions.read(identity.sessionId);
    const events = [];
    for await (const event of child.read()) events.push(event);
    const hard = events.find(event => event.type === 'block.warning' && event.data.code === 'hard_step_limit');
    assert.ok(hard, 'the bound is a durable, non-transient fact of the child session');
    assert.equal(hard.data.transient, false);
    assert.equal(hard.data.steps, 3);

    const session = await kernel.ctx.sessions.read('run-bound');
    const parent = [];
    for await (const event of session.read()) parent.push(event);
    const status = parent.filter(event => event.type === 'block.status' && event.data.taskId === 'inspect').at(-1);
    assert.equal(status.data.status, 'failed');
    assert.equal(status.data.failure.code, 'tools_withdrawn');
    assert.equal(status.data.retryState, 'not_retryable',
      'a worker that already stalled is not silently re-run at the same cost');
    assert.ok(parent.some(event => event.type === 'block.output' && event.data.taskId === 'inspect'),
      'the partial deliverable is still recorded against the task that produced it');
  } finally {
    await kernel.dispose();
  }
});

test('shell tools are withheld from generated workers when confined commands are unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-task-graph-noshell-'));
  const kernel = createKernel();
  const llm = toolHungryLlm(contract([task('change', { writeFiles: ['out.txt'] })]), { toolName: 'bash' });
  let shells = 0;
  await kernel.ctx.plugin(flytTools);
  kernel.ctx.tools.register({
    name: 'peek', description: 'Read.', parameters: { type: 'object' },
    classification: { effect: 'read', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { return { content: 'read' }; },
  });
  kernel.ctx.tools.register({
    name: 'bash', description: 'Run.', parameters: { type: 'object' },
    classification: { effect: 'shell', destructive: false, untrustedInput: false, source: 'confirmed' },
    async execute() { shells += 1; return { content: 'ran' }; },
  });
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'fake-llm', apply(ctx) { return provideSeam(ctx, 'llm', llm.seam); } });
  await kernel.ctx.plugin({ name: 'fake-sandbox', apply(ctx) {
    return provideSeam(ctx, 'sandbox', {
      world: { id: 'test' },
      async probe() {
        return { platform: process.platform, backend: 'windows-restricted-token', available: false, enforcement: null,
          checkedAt: new Date().toISOString(), reason: 'Confined command tools are unavailable for this sign-in.' };
      },
      async confine() { throw new Error('must not be reached'); },
      async disposeOwner() {},
    });
  } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'run-noshell', blockId: 'dispatch', input: 'Change it.', ceiling: ['peek', 'bash'],
      config: { model: 'fake', workerMaxSteps: 3 },
    });
    assert.equal(outcome.status, 'done', outcome.error);
    assert.equal(shells, 0);
    assert.deepEqual(llm.seen[1].tools.map(tool => tool.name), ['peek'],
      'a write task keeps its readers and loses only the shell it cannot use');
    assert.equal(llm.seen.length, 2, 'the worker answered at once because nothing invited a doomed command');
    const system = llm.seen[1].messages.find(message => message.role === 'system').content;
    assert.match(system, /Shell commands are unavailable in this run/);

    const identity = childSessionIdentity({ parentRunId: 'run-noshell', parentBlockId: 'dispatch', taskId: 'change', profileId: 'default-work' });
    const child = await kernel.ctx.sessions.read(identity.sessionId);
    const events = [];
    for await (const event of child.read()) events.push(event);
    const warning = events.find(event => event.type === 'block.warning' && event.data.code === 'commands_unavailable');
    assert.ok(warning, 'withholding a tool is an explicit fact of the session');
    assert.deepEqual(warning.data.withheld, ['bash']);
    assert.match(warning.data.reason, /unavailable for this sign-in/);
  } finally {
    await kernel.dispose();
  }
});
