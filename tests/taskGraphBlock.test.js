import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytTools, sessionJsonl, provideSeam,
  executeTaskGraph, parseTaskGraphPlan,
} from '#kernel';
import { stackWithGeneratedTasks } from '../core/kernelRunner.js';

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
  const llm = fakeLlm(contract([task('alpha'), task('beta')]));
  await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({ name: 'fake-llm', apply(ctx) { return provideSeam(ctx, 'llm', llm.seam); } });
  try {
    const outcome = await executeTaskGraph({
      ctx: kernel.ctx, runId: 'run-1', blockId: 'dispatch', input: 'Build it.', ceiling: [],
      config: { model: 'fake', parallelism: 'high', maxTasks: 4, maxParallel: 2, workerMaxSteps: 1 },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(llm.peak, 2, 'both ready tasks ran in the same bounded wave');
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
  } finally {
    await kernel.dispose();
  }
});
