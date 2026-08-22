// Resume replays to the last durable event, and a tool call that never
// returned is reconstructed (t-0068).
//
// The slice that makes the session log worth having. v1 reconstructed state
// from status files and had to be told what each one meant; here the log IS the
// record, so resuming is a read (D55). What must not happen is the quiet
// version of correct: a block re-run and charged for twice, or a tool call
// dropped so the resumed conversation has a different shape from the one that
// was interrupted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, flytStackRunner, sessionJsonl, parseStack, NEVER_RETURNED } from '#kernel';

const THREE = `version: 2
id: demo
blocks:
  - id: one
    use: demo:work
  - id: two
    use: demo:work
  - id: three
    use: demo:work
`;

/**
 * A kernel over ONE runs directory, so a second kernel can be booted against
 * the same logs — which is what "the process died" means here.
 */
async function bootAt(root, execute) {
  const kernel = createKernel();
  const ran = [];
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root });
  await kernel.ctx.plugin({
    name: 'demo-blocks',
    inject: ['blocks'],
    apply(ctx) {
      ctx.blocks.register({
        use: 'demo:work', title: 'W', description: '', category: 'work',
        settings: { type: 'object' }, ceiling: null,
        async execute(run) {
          ran.push(run.blockId);
          return (await execute?.(run)) ?? { status: 'done', output: `${run.blockId} done` };
        },
      });
    },
  });
  const stack = parseStack(THREE);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => stack.root } });
  return { kernel, ran };
}

const eventsIn = async (kernel, runId) => {
  const session = await kernel.ctx.sessions.read(runId);
  const out = [];
  for await (const e of session.read()) out.push(e);
  return out;
};

test('a run killed between blocks resumes and finishes what it had not reached', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));

  // First process: stops after "one", the way a killed loop leaves it.
  const first = await bootAt(root, async ({ blockId }) => {
    if (blockId === 'one') await run.stop('the process is going away');
    return { status: 'done', output: `${blockId} done` };
  });
  var run = await first.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'the input');
  assert.equal((await run.settled()).status, 'stopped');
  assert.deepEqual(first.ran, ['one']);
  await first.kernel.dispose();

  // Second process, same logs, nothing in memory.
  const second = await bootAt(root);
  const resumed = await second.kernel.ctx.agents.resume('run-1');
  assert.equal((await resumed.settled()).status, 'done');
  assert.deepEqual(second.ran, ['two', 'three'],
    'the block that already finished is not run again — a resume must not charge twice');
  await second.kernel.dispose();
});

test('what a resumed block is fed is what the finished one produced', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const first = await bootAt(root, async ({ blockId }) => {
    if (blockId === 'one') await run.stop('bye');
    return { status: 'done', output: `${blockId} produced this` };
  });
  var run = await first.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  await run.settled();
  await first.kernel.dispose();

  const seen = [];
  const second = await bootAt(root, async ({ blockId, input }) => {
    seen.push({ blockId, input });
    return { status: 'done', output: `${blockId} produced this` };
  });
  await (await second.kernel.ctx.agents.resume('run-1')).settled();
  assert.equal(seen[0].blockId, 'two');
  assert.equal(seen[0].input, 'one produced this',
    'the carry comes from the log, not from a re-run of the block that made it');
  await second.kernel.dispose();
});

test('a tool call that never returned is reconstructed, not dropped', async () => {
  // The process died mid-tool: the call is in the log and its result is not.
  // `deriveMessages` is where the promise lives, and this is the shape a real
  // interrupted run leaves behind.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const kernel = createKernel();
  await kernel.ctx.plugin(sessionJsonl, { root });
  const session = await kernel.ctx.sessions.open('run-9');
  await session.append({ type: 'run.created', data: { runId: 'run-9', stackId: 'demo', input: 'in' } });
  await session.append({ type: 'message.system', data: { content: 'sys' } });
  await session.append({ type: 'message.user', data: { content: 'do it' } });
  await session.append({
    type: 'llm.response',
    data: { content: 'Looking.', toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'ls' } }], finishReason: 'tool_calls' },
  });
  // ...and here the process dies. No tool.result.

  const messages = await session.deriveMessages();
  const answer = messages.at(-1);
  assert.equal(answer.role, 'tool');
  assert.equal(answer.toolCallId, 'c1');
  assert.equal(answer.content, NEVER_RETURNED);
  assert.match(answer.content, /never returned/);
  assert.equal(messages.filter(m => m.role === 'tool').length, 1,
    'one call, one answer — a dropped call is how a resumed conversation changes shape');
  await kernel.dispose();
});

test('resuming a settled run returns its outcome rather than running it again', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const first = await bootAt(root);
  await (await first.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled();
  assert.deepEqual(first.ran, ['one', 'two', 'three']);
  await first.kernel.dispose();

  const second = await bootAt(root);
  const resumed = await second.kernel.ctx.agents.resume('run-1');
  assert.equal((await resumed.settled()).status, 'done');
  assert.deepEqual(second.ran, [], 'nothing ran, because nothing was left to run');
  // And it did not write a second ending onto a finished log.
  const stages = (await eventsIn(second.kernel, 'run-1'))
    .filter(e => e.type === 'run.stage').map(e => e.data.stage);
  assert.deepEqual(stages, ['execution', 'done']);
  await second.kernel.dispose();
});

test('resuming a failed run reports the failure it already had', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const first = await bootAt(root, async ({ blockId }) =>
    (blockId === 'two'
      ? { status: 'failed', output: '', error: 'the file was not there' }
      : { status: 'done', output: 'ok' }));
  assert.equal((await (await first.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in')).settled()).status, 'failed');
  await first.kernel.dispose();

  const second = await bootAt(root);
  const outcome = await (await second.kernel.ctx.agents.resume('run-1')).settled();
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error, /the file was not there/);
  assert.deepEqual(second.ran, []);
  await second.kernel.dispose();
});

test('a resume is announced in the log, saying how much it replayed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const first = await bootAt(root, async ({ blockId }) => {
    if (blockId === 'one') await run.stop('bye');
    return { status: 'done', output: 'ok' };
  });
  var run = await first.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  await run.settled();
  await first.kernel.dispose();

  const second = await bootAt(root);
  await (await second.kernel.ctx.agents.resume('run-1')).settled();
  const resumed = (await eventsIn(second.kernel, 'run-1'))
    .find(e => e.type === 'run.stage' && e.data.stage === 'resumed');
  assert.ok(resumed, 'a resume that leaves no trace is a run whose history has a hole in it');
  assert.equal(resumed.data.replayed, 1, 'one block was taken from the log rather than re-run');
  await second.kernel.dispose();
});

test('resuming a run with no log refuses, naming the run', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-resume-'));
  const boot = await bootAt(root);
  await assert.rejects(() => boot.kernel.ctx.agents.resume('never-existed'),
    /Run "never-existed" has no session log/);
  await boot.kernel.dispose();
});
