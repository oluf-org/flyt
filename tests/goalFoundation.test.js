import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, flytTools, flytApprovals, flytStackRunner, sessionJsonl, provideSeam, flytBlocksLoop, flytBlocksJudgement } from '#kernel';
const node = (id, use) => ({ kind: 'block', id, use, config: {}, outputs: [], position: { line: 1, path: id } });
const seq = children => ({ kind: 'sequence', id: 'root', children, position: { line: 0, path: '' } });
async function probe(t, definition, answer) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-goal-foundation-'));
  const kernel = createKernel();
  await kernel.ctx.plugin(flytBlocks); await kernel.ctx.plugin(flytTools);
  await kernel.ctx.plugin(flytApprovals, { mode: 'always' }); await kernel.ctx.plugin(sessionJsonl, { root });
  kernel.ctx.blocks.register(definition);
  let calls = 0;
  await kernel.ctx.plugin({ name: 'goal-test-model', apply(ctx) {
    return provideSeam(ctx, 'llm', { stream() {
      calls++;
      return { async *[Symbol.asyncIterator]() { yield { text: answer }; }, async settled() { return { content: answer, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }; } };
    }, async models() { return []; } });
  } });
  t.after(async () => { await kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { kernel, calls: () => calls };
}
test('typed JSON evaluation satisfies exact Until equality in one pass', async t => {
  const p = await probe(t, flytBlocksJudgement.evaluationBlock, JSON.stringify({ verdict: 'pass', success: true, score: 1, explanation: 'The recorded checks passed' }));
  await p.kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => seq([{ kind: 'until', id: 'improve', max: 2, condition: { source: 'evaluate.verdict', operator: 'is', literal: 'pass' }, children: [node('evaluate', 'flyt-blocks-judgement:evaluation')] }]) } });
  assert.equal((await (await p.kernel.ctx.agents.start({ id: 'evaluation', runId: 'evaluation' }, 'brief')).settled()).status, 'done');
  assert.equal(p.calls(), 1);
});
test('prose and contradictory structured evaluations fail closed', async t => {
  for (const output of ['pass — all checks succeeded', '{"verdict":"pass","success":false,"score":1,"explanation":"oops"}', '{"verdict":"pass","success":true,"score":"1","explanation":"oops"}']) {
    await t.test(output, async t => {
      const p = await probe(t, flytBlocksJudgement.evaluationBlock, output);
      await p.kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => seq([node('evaluate', 'flyt-blocks-judgement:evaluation')]) } });
      assert.equal((await (await p.kernel.ctx.agents.start({ id: 'evaluation', runId: 'evaluation' }, 'brief')).settled()).status, 'failed');
    });
  }
});
test('legacy handoff fails explicitly without a model call or a false queue receipt', async t => {
  const p = await probe(t, flytBlocksLoop.loopHandoffBlock, 'Queued task A');
  await p.kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => seq([node('handoff', 'flyt-blocks-loop:loop-handoff')]) } });
  const result = await (await p.kernel.ctx.agents.start({ id: 'handoff', runId: 'handoff' }, 'tasks')).settled();
  assert.equal(result.status, 'failed'); assert.match(result.error, /No tasks were queued/); assert.equal(p.calls(), 0);
});
test('resume runs the recorded tree even when the library source is replaced or removed', async t => {
  const p = await probe(t, { use: 'probe:work', title: 'Work', category: 'utility', settings: {}, ceiling: [], execute: async () => ({ status: 'done', output: '' }) }, 'unused');
  let current = seq([node('one', 'probe:work'), node('original-next', 'probe:work')]);
  const ran = []; let running;
  p.kernel.ctx.blocks.require('probe:work').execute = async run => {
    ran.push(run.blockId); if (run.blockId === 'one') await running.stop('pause boundary');
    return { status: 'done', output: run.blockId };
  };
  await p.kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => current } });
  running = await p.kernel.ctx.agents.start({ id: 'pin', runId: 'pin' }, 'objective');
  assert.equal((await running.settled()).status, 'stopped'); current = null;
  assert.equal((await (await p.kernel.ctx.agents.resume('pin')).settled()).status, 'done');
  assert.deepEqual(ran, ['one', 'original-next']);
});
