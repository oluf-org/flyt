// Diagnostic probes of current behavior, not acceptance tests for the proposed feature.
// Run after npm run build:kernel. Uses fake models and temporary session logs only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createKernel, flytBlocks, flytTools, flytApprovals, flytStackRunner,
  sessionJsonl, provideSeam, flytBlocksLoop, flytBlocksJudgement,
} from '#kernel';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-loop-review-'));
const node = (id, use) => ({ kind: 'block', id, use, config: {}, outputs: [], position: { line: 1, path: id } });
const seq = children => ({ kind: 'sequence', id: 'root', children });
const eventsOf = async (ctx, id) => {
  const events = [];
  for await (const event of (await ctx.sessions.read(id)).read()) events.push(event);
  return events;
};

async function aiProbe(id, definition, tree, answer) {
  const kernel = createKernel();
  const seen = [];
  try {
    await kernel.ctx.plugin(flytBlocks);
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await kernel.ctx.plugin(sessionJsonl, { root });
    kernel.ctx.blocks.register(definition);
    await kernel.ctx.plugin({ name: `probe-model-${id}`, apply(ctx) {
      return provideSeam(ctx, 'llm', {
        stream(request) {
          seen.push({ tools: request.tools ?? [], messages: request.messages });
          const result = { content: answer, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          return { async *[Symbol.asyncIterator]() { yield { text: answer }; }, async settled() { return result; } };
        },
        async models() { return []; },
      });
    } });
    await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => tree }, ceiling: [] });
    const outcome = await (await kernel.ctx.agents.start({ id, runId: id }, 'Review input')).settled();
    return { outcome, seen, events: await eventsOf(kernel.ctx, id) };
  } finally { await kernel.dispose(); }
}

try {
  const handoff = await aiProbe('handoff', flytBlocksLoop.loopHandoffBlock,
    seq([node('handoff', 'flyt-blocks-loop:loop-handoff')]), 'Queued task A');
  assert.equal(handoff.outcome.status, 'done');
  assert.equal(handoff.seen[0].tools.length, 0);
  assert.equal(handoff.events.filter(e => e.type === 'tool.call').length, 0);
  console.log('CONFIRMED: Loop handoff reports done with a textual queue claim and no queue operation.');

  const evaluation = await aiProbe('verdict', flytBlocksJudgement.evaluationBlock,
    seq([{ kind: 'until', id: 'improve', max: 2,
      condition: { source: 'evaluate.verdict', operator: 'is', literal: 'pass' },
      children: [node('evaluate', 'flyt-blocks-judgement:evaluation')] }]), 'pass — all checks succeeded');
  assert.equal(evaluation.outcome.status, 'failed');
  assert.equal(evaluation.seen.length, 2);
  console.log('CONFIRMED: A prose pass verdict misses exact Until equality and exhausts both iterations.');

  const kernel = createKernel();
  try {
    await kernel.ctx.plugin(flytBlocks);
    await kernel.ctx.plugin(sessionJsonl, { root });
    const original = seq([node('one', 'probe:work'), node('old-next', 'probe:work')]);
    let current = original;
    const ran = [];
    let running;
    kernel.ctx.blocks.register({ use: 'probe:work', title: 'Probe', description: '', category: 'utility',
      settings: {}, ceiling: [], async execute(run) {
        ran.push(run.blockId);
        if (run.blockId === 'one') await running.stop('probe boundary');
        return { status: 'done', output: `${run.blockId} output` };
      } });
    await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => current } });
    running = await kernel.ctx.agents.start({ id: 'revision', runId: 'revision' }, 'Original goal');
    assert.equal((await running.settled()).status, 'stopped');
    current = seq([node('one', 'probe:work'), node('replacement', 'probe:work')]);
    assert.equal((await (await kernel.ctx.agents.resume('revision')).settled()).status, 'done');
    assert.deepEqual(ran, ['one', 'replacement']);
    const recorded = (await eventsOf(kernel.ctx, 'revision')).find(e => e.type === 'stack.resolved');
    assert.equal(recorded.data.stack.children[1].id, 'old-next');
    console.log('CONFIRMED: Resume executes a changed definition despite the original stack.resolved snapshot.');
  } finally { await kernel.dispose(); }
} finally {
  // Verify the resolved temporary target before recursive cleanup on Windows.
  const resolved = fs.realpathSync(root);
  const temp = fs.realpathSync(os.tmpdir());
  const relative = path.relative(temp, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(resolved).startsWith('flyt-loop-review-')) {
    throw new Error('Unexpected probe cleanup path');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}
