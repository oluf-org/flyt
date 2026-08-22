// Stop lands at a durable boundary, and the log says where (t-0067).
//
// "Durable boundary" is a place, not a feeling: between children of a
// container, after the event recording the last one has been appended. A stop
// that lands anywhere else leaves a log that disagrees with the workspace.
//
// An in-flight block is allowed to FINISH. Cancelling it mid-flight is how a
// provider gets billed for work no record survives, which the aborted-spend
// work already found from the other direction.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, flytStackRunner, sessionJsonl, parseStack } from '#kernel';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-stop-'));

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

async function bootStop(execute) {
  const kernel = createKernel();
  const record = [];
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root: tmp() });
  await kernel.ctx.plugin({
    name: 'demo-blocks',
    inject: ['blocks'],
    apply(ctx) {
      ctx.blocks.register({
        use: 'demo:work',
        title: 'Work',
        description: '',
        category: 'work',
        settings: { type: 'object' },
        ceiling: null,
        async execute(run) {
          record.push(run.blockId);
          return (await execute?.(run)) ?? { status: 'done', output: `${run.blockId} done` };
        },
      });
    },
  });
  const stack = parseStack(THREE);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => stack.root } });
  return { kernel, record };
}

const eventsIn = async (kernel, runId) => {
  const session = await kernel.ctx.sessions.read(runId);
  const out = [];
  for await (const e of session.read()) out.push(e);
  return out;
};

test('a stop between blocks ends the run as stopped, with the reason it was given', async () => {
  let run;
  const boot = await bootStop(async ({ blockId }) => {
    if (blockId === 'one') await run.stop('the person asked');
    return { status: 'done', output: `${blockId} done` };
  });

  run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  const outcome = await run.settled();

  assert.equal(outcome.status, 'stopped');
  assert.equal(outcome.reason, 'the person asked');
  assert.deepEqual(boot.record, ['one'], 'the block in flight finished; the next one never started');
  await boot.kernel.dispose();
});

test('a block already running is allowed to finish, and its result is in the log', async () => {
  let run;
  const boot = await bootStop(async ({ blockId }) => {
    if (blockId === 'one') {
      // Asked to stop WHILE this block is working. Cancelling here would leave
      // a block that was paid for and produced no record.
      await run.stop('mid-block');
      await new Promise(r => setTimeout(r, 10));
    }
    return { status: 'done', output: `${blockId} produced this` };
  });

  run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  await run.settled();

  const events = await eventsIn(boot.kernel, 'run-1');
  const output = events.find(e => e.type === 'block.output' && e.data.blockId === 'one');
  assert.ok(output, 'the block that was running when the stop arrived still wrote its output');
  assert.equal(output.data.content, 'one produced this');
  assert.ok(events.some(e => e.type === 'block.status' && e.data.blockId === 'one' && e.data.status === 'done'));
  await boot.kernel.dispose();
});

test('the log names where it stopped', async () => {
  let run;
  const boot = await bootStop(async ({ blockId }) => {
    if (blockId === 'two') await run.stop('enough');
    return { status: 'done', output: `${blockId} done` };
  });

  run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  await run.settled();

  const stopped = (await eventsIn(boot.kernel, 'run-1'))
    .find(e => e.type === 'run.stage' && e.data.stage === 'stopped');
  assert.ok(stopped, 'the stage is in the log, not only in the return value');
  assert.equal(stopped.data.reason, 'enough');
  assert.equal(stopped.data.afterBlock, 'two',
    'a stop that cannot say where it landed is a stop nobody can resume from');
  assert.equal(stopped.data.blocksRan, 2);
  await boot.kernel.dispose();
});

test('stopping a run that already settled is not an error', async () => {
  const boot = await bootStop();
  const run = await boot.kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  assert.equal((await run.settled()).status, 'done');

  await run.stop('too late');
  assert.equal((await run.settled()).status, 'done', 'and it does not rewrite what happened');

  // Twice, because a caller that crashed halfway through a shutdown has to be
  // able to finish it.
  await run.stop('again');
  await boot.kernel.dispose();
});

test('a stop inside a parallel lets the wave finish and stops before the next one', async () => {
  const kernel = createKernel();
  const started = [];
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root: tmp() });
  let run;
  await kernel.ctx.plugin({
    name: 'demo-blocks',
    inject: ['blocks'],
    apply(ctx) {
      ctx.blocks.register({
        use: 'demo:work', title: 'W', description: '', category: 'work',
        settings: { type: 'object' }, ceiling: null,
        async execute({ blockId }) {
          started.push(blockId);
          if (blockId === 'la') await run.stop('halfway');
          return { status: 'done', output: 'ok' };
        },
      });
    },
  });
  const stack = parseStack(`version: 2
id: demo
blocks:
  - id: fan
    kind: parallel
    maxParallel: 2
    lanes:
      - id: left
        kind: sequence
        blocks:
          - id: la
            use: demo:work
      - id: middle
        kind: sequence
        blocks:
          - id: ma
            use: demo:work
      - id: right
        kind: sequence
        blocks:
          - id: ra
            use: demo:work
`);
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => stack.root } });

  run = await kernel.ctx.agents.start({ id: 'demo', runId: 'run-1' }, 'in');
  assert.equal((await run.settled()).status, 'stopped');
  assert.deepEqual(started.sort(), ['la', 'ma'],
    'the wave that was in flight completed, and the third lane never started');
  await kernel.dispose();
});
