import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools, flytApprovals } from '#kernel';
import { verifyPayload } from '../plugins/impeccable-flyt-plugin/verify-provenance.mjs';

const call = { runId: 'r', blockId: 'b', step: 1, call: { id: 'c', name: 'impeccable_detect', args: { paths: ['tests/fixtures/impeccable-bounce.css'] } }, ceiling: ['impeccable_detect'] };

test('the bundled provider payload has reproducible upstream provenance', async () => {
  const verified = await verifyPayload();
  assert.equal(verified.fileCount, 153);
  assert.equal(verified.sha256, '15b2b5e277aa401ef89c348639353aa709a00f96954068700b7385e28fdb1d5b');
  assert.equal(verified.artifactSha256, '0d41426a06c9a4119980323d2a2dd4da7f278fb3cface84a8650b25b8b896626');
});

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
    const product = await kernel.ctx.tools.execute({
      ...call,
      call: { ...call.call, id: 'c-clean', args: { paths: ['src/v2'] } },
    });
    assert.deepEqual(JSON.parse(product.content), [], 'the shipping v2 surfaces contain no detected UI antipatterns');
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
