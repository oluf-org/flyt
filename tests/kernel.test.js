// The v2 kernel's spine: a context boots, a plugin mounts on it, and disposing
// the kernel unwinds what the plugin registered. Nothing here touches the
// running app — with the v2 flag off (D62) no other module imports #kernel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel } from '#kernel';

test('the kernel boots with a profile and a root context', () => {
  const kernel = createKernel();
  assert.equal(kernel.profile, 'flyt-cli', 'the CLI profile is the default');
  assert.ok(kernel.ctx, 'a root context exists');
  return kernel.dispose();
});

test('a profile is chosen, not inferred', () => {
  const kernel = createKernel({ profile: 'flyt-loop-worker' });
  assert.equal(kernel.profile, 'flyt-loop-worker');
  return kernel.dispose();
});

test('a plugin mounts, provides a service, and is unwound by dispose()', async () => {
  const kernel = createKernel();
  const seen = [];

  await kernel.ctx.plugin({
    name: 'trivial',
    apply(ctx) {
      ctx.provide('trivial');
      ctx.trivial = { greet: () => 'hello' };
      seen.push('applied');
      return () => seen.push('disposed');
    },
  });

  assert.equal(kernel.ctx.trivial.greet(), 'hello', 'the service resolves through ctx');
  assert.deepEqual(seen, ['applied']);

  await kernel.dispose();
  assert.deepEqual(seen, ['applied', 'disposed'], 'disposal ran the plugin disposer');
  assert.equal(kernel.ctx.trivial, undefined, 'and the service is gone with it');
});

test('disposing twice is not an error', async () => {
  const kernel = createKernel();
  await kernel.dispose();
  await kernel.dispose();
});

test('a plugin waits for a service it injects', async () => {
  const kernel = createKernel();
  const order = [];

  await kernel.ctx.plugin({
    name: 'consumer',
    inject: ['late'],
    apply(ctx) { order.push(`saw ${ctx.late.value}`); },
  });
  assert.deepEqual(order, [], 'it does not run while the dependency is missing');

  await kernel.ctx.plugin({
    name: 'provider',
    apply(ctx) { ctx.provide('late'); ctx.late = { value: 42 }; },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(order, ['saw 42'], 'and runs once the dependency arrives');
  await kernel.dispose();
});
