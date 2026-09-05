import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKernel, flytBlocks, flytStackRunner, sessionJsonl } from '#kernel';

const block = id => ({ kind: 'block', id, use: 'test:work', config: {}, outputs: [] });
async function boot(t, children, execute) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flyt-iteration-'));
  const kernel = createKernel();
  t.after(async () => { await kernel.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  await kernel.ctx.plugin(flytBlocks);
  await kernel.ctx.plugin(sessionJsonl, { root });
  const calls = [];
  kernel.ctx.blocks.register({ use: 'test:work', title: 'Work', description: '', category: 'utility', settings: {}, ceiling: [],
    async execute(run) { calls.push(run); return execute?.(run, kernel) ?? { status: 'done', output: run.input + '!' }; } });
  await kernel.ctx.plugin(flytStackRunner, { stacks: { resolve: () => ({ kind: 'sequence', id: 'root', children }) } });
  const session = await kernel.ctx.sessions.open('run');
  return { kernel, calls, session,
    start: async () => (await kernel.ctx.agents.start({ id: 'test', runId: 'run' }, 'input')).settled(),
    resume: async () => (await kernel.ctx.agents.resume('run')).settled() };
}

test('repeat runs every nested iteration and carries only its predecessor output', async t => {
  const b = await boot(t, [{ kind: 'repeat', id: 'outer', count: 2, children: [
    { kind: 'repeat', id: 'inner', count: 2, children: [block('work')] },
  ] }]);
  assert.equal((await b.start()).status, 'done');
  assert.deepEqual(b.calls.map(r => r.input), ['input', 'input!', 'input!!', 'input!!!']);
  assert.equal(new Set(b.calls.map(r => r.context.executionId)).size, 4);
  assert.equal(new Set(b.calls.map(r => r.context.after)).size, 4);
});

test('resume continues remaining foreach items and exports the last structured artifact', async t => {
  let stop = true;
  const b = await boot(t, [block('roster'),
    { kind: 'foreach', id: 'items', roster: 'roster.items', max: 3, children: [block('item')] },
    { kind: 'if', id: 'check', predicate: { source: 'item.last', operator: 'is', literal: 'third' }, children: [block('joined')] },
  ], async (run, kernel) => {
    if (run.blockId === 'roster') return { status: 'done', output: 'roster', structured: { items: ['first', 'second', 'third'] } };
    if (run.blockId === 'item' && stop) { stop = false; await kernel.ctx.agents.get(run.runId).stop('test'); }
    return { status: 'done', output: run.input, structured: { last: run.input } };
  });
  assert.equal((await b.start()).status, 'stopped');
  assert.equal((await b.resume()).status, 'done');
  assert.deepEqual(b.calls.filter(r => r.blockId === 'item').map(r => r.input), ['first', 'second', 'third']);
  assert.equal(b.calls.at(-1).blockId, 'joined');
});

test('legacy foreach replay consumes the one old outcome only for its first element', async t => {
  const b = await boot(t, [block('roster'), { kind: 'foreach', id: 'items', roster: 'roster.items', max: 2, children: [block('item')] }]);
  for (const event of [
    { type: 'run.created', data: { stackId: 'test', input: 'input' } },
    { type: 'block.status', data: { blockId: 'roster', status: 'done', structured: { items: ['first', 'second'] } } },
    { type: 'block.output', data: { blockId: 'item', content: 'first done' } },
    { type: 'block.status', data: { blockId: 'item', status: 'done' } },
  ]) await b.session.append(event);
  assert.equal((await b.resume()).status, 'done');
  assert.deepEqual(b.calls.map(r => r.input), ['second']);
});

test('a stopped until does not falsely report exhausting its pass limit', async t => {
  let stop = true;
  const b = await boot(t, [{ kind: 'until', id: 'until', max: 3,
    condition: { source: 'work.accepted', operator: 'is', literal: true }, children: [block('work')] }], async (run, kernel) => {
    if (stop) { stop = false; await kernel.ctx.agents.get(run.runId).stop('test'); return { status: 'done', output: 'first', structured: { accepted: false } }; }
    return { status: 'done', output: 'accepted', structured: { accepted: true } };
  });
  assert.equal((await b.start()).status, 'stopped');
  assert.ok(!b.session.readSync().some(e => e.type === 'block.status' && e.data.blockId === 'until' && e.data.status === 'failed'));
  assert.equal((await b.resume()).status, 'done');
  assert.equal(b.calls.length, 2);
});

test('supervisor restart invalidates all executions of the named repeated block', async t => {
  const b = await boot(t, [{ kind: 'repeat', id: 'twice', count: 2, children: [block('work')] }]);
  assert.equal((await b.start()).status, 'done');
  await b.session.append({ type: 'block.status', data: { blockId: 'work', status: 'pending', reason: 'restarted by supervisor', guidance: 'EXPLICIT_CORRECTION' } });
  assert.equal((await b.resume()).status, 'done');
  assert.equal(b.calls.length, 4);
  assert.ok(b.calls[2].context.after > b.calls[1].context.after);
  assert.match(b.calls[2].input, /Supervisor restart guidance:\nEXPLICIT_CORRECTION/);
});
