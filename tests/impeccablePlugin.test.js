import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools, flytApprovals } from '#kernel';

const call = { runId: 'r', blockId: 'b', step: 1, call: { id: 'c', name: 'impeccable_detect', args: { paths: ['src/v2'] } }, ceiling: ['impeccable_detect'] };

test('the detector is a real package resolvable by the ordinary external importer', async () => {
  const plugin = await import('impeccable-flyt-plugin');
  assert.equal(plugin.name, 'impeccable');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
});

test('Impeccable uses external install, inference, human confirmation and the ordinary ceiling', async () => {
  const kernel = createKernel();
  let proposal;
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }]).then(() => assert.fail('install settled without an attended surface'), error => {
      assert.match(error.message, /attended human classification review/);
    });

    const detach = kernel.pluginReviews.subscribe(() => {});
    const installing = kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }]);
    for (let i = 0; i < 20 && !kernel.pluginReviews.snapshot(); i++) await Promise.resolve();
    const pending = kernel.pluginReviews.snapshot();
    proposal = pending.proposals[0];
    assert.equal(proposal.name, 'impeccable_detect');
    assert.equal(proposal.effect, 'shell', 'the CLI claim raises tools-only inference conservatively');
    assert.equal(proposal.source, 'inferred', 'Impeccable cannot confirm itself');
    pending.decide({ impeccable_detect: proposal });
    await installing;
    detach();

    assert.equal(kernel.ctx.tools.get('impeccable_detect').classification.source, 'confirmed');
    const denied = await kernel.ctx.tools.execute({ ...call, ceiling: [] });
    assert.match(denied.error, /not in this block's ceiling/);
    const detected = await kernel.ctx.tools.execute(call);
    assert.equal(detected.error, undefined);
    assert.match(detected.content, /bounce-easing/,
      'the installed external artifact executes the detector bundled in the provider payload');
  } finally { await kernel.dispose(); }
});

test('the Loop refuses Impeccable before importing it', async () => {
  const kernel = createKernel({ profile: 'flyt-loop-worker' });
  try {
    await assert.rejects(
      () => kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }]),
      /attended human classification review/,
    );
    assert.equal(kernel.ctx.tools?.get?.('impeccable_detect'), undefined);
  } finally { await kernel.dispose(); }
});
