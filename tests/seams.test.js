// The eight capability seams, and the property that makes them worth having:
// a consumer resolves a seam through ctx and never learns which provider it
// got. Everything here runs against #kernel only — the v1 app is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, SEAM_NAMES, KERNEL_EVENTS, provideSeam } from '#kernel';

// The consumer. Written once, against the seam, with no idea who provides it.
async function summarise(ctx) {
  const entries = await ctx.fs.list();
  const names = entries.map(e => e.path).sort();
  const first = names.length ? await ctx.fs.read(names[0]) : '';
  return `${names.join(',')}|${first}`;
}

function memoryFs(files) {
  const store = new Map(Object.entries(files));
  return {
    root: 'memory:/',
    async read(p) {
      if (!store.has(p)) throw new Error(`No such file: ${p}`);
      return store.get(p);
    },
    async write(p, content) { store.set(p, content); },
    async exists(p) { return store.has(p); },
    async list() { return [...store.keys()].map(path => ({ path, kind: 'file' })); },
    async remove(p) { store.delete(p); },
  };
}

test('the seam list is the eight the plan names, and nothing else', () => {
  assert.deepEqual([...SEAM_NAMES], [
    'sessions', 'tools', 'llm', 'fs', 'shell', 'agents', 'commands', 'sandbox',
  ]);
});

test('the event contract is the turn, in order', () => {
  assert.deepEqual([...KERNEL_EVENTS], [
    'turn/start', 'agent/pre-step', 'step/start', 'llm/stream', 'tool/call',
    'tools/pre-execute', 'tools/post-execute', 'tools/change', 'commands/invoke', 'step/end',
    'turn/end', 'session/append',
  ]);
});

test('one consumer, two providers, no idea which', async () => {
  const results = [];

  for (const files of [{ 'a.md': 'from A' }, { 'b.md': 'from B', 'c.md': 'also B' }]) {
    const kernel = createKernel();
    await kernel.ctx.plugin({
      name: 'an-fs-provider',
      apply(ctx) { return provideSeam(ctx, 'fs', memoryFs(files)); },
    });
    results.push(await summarise(kernel.ctx));
    await kernel.dispose();
  }

  assert.deepEqual(results, ['a.md|from A', 'b.md,c.md|from B']);
});

test('a seam withdraws when the plugin that provided it unloads', async () => {
  const kernel = createKernel();
  const fiber = await kernel.ctx.plugin({
    name: 'an-fs-provider',
    apply(ctx) { return provideSeam(ctx, 'fs', memoryFs({ 'a.md': 'x' })); },
  });

  assert.equal(kernel.ctx.fs.root, 'memory:/');
  await fiber.dispose();
  assert.equal(kernel.ctx.fs, undefined, 'the consumer stops rather than holding a dead reference');

  await kernel.dispose();
});

test('a consumer that injects a seam waits for a provider instead of failing', async () => {
  const kernel = createKernel();
  const seen = [];

  await kernel.ctx.plugin({
    name: 'a-consumer',
    inject: ['fs'],
    async apply(ctx) { seen.push(await summarise(ctx)); },
  });
  assert.deepEqual(seen, [], 'nothing ran while the seam was unprovided');

  await kernel.ctx.plugin({
    name: 'an-fs-provider',
    apply(ctx) { return provideSeam(ctx, 'fs', memoryFs({ 'late.md': 'arrived' })); },
  });
  await new Promise(resolve => setTimeout(resolve, 10));

  assert.deepEqual(seen, ['late.md|arrived']);
  await kernel.dispose();
});

test('tools/pre-execute is a waterfall a listener can veto', async () => {
  const kernel = createKernel();
  const exec = {
    runId: 'r1', blockId: 'b1', step: 1,
    call: { id: 'c1', name: 'write_file', args: { path: 'x' } },
    ceiling: ['read_file'],
  };

  await kernel.ctx.plugin({
    name: 'a-ceiling',
    apply(ctx) {
      ctx.on('tools/pre-execute', async (pending, next) => {
        if (!pending.ceiling.includes(pending.call.name)) {
          return { decision: 'deny', reason: `"${pending.call.name}" is not in this block's ceiling` };
        }
        return next();
      });
    },
  });

  const denied = await kernel.ctx.waterfall('tools/pre-execute', exec, async () => ({ decision: 'allow' }));
  assert.equal(denied.decision, 'deny');
  assert.match(denied.reason, /not in this block's ceiling/);

  const allowed = await kernel.ctx.waterfall(
    'tools/pre-execute',
    { ...exec, call: { ...exec.call, name: 'read_file' } },
    async () => ({ decision: 'allow' }),
  );
  assert.equal(allowed.decision, 'allow', 'and delegates to next() when it has no objection');

  await kernel.dispose();
});
