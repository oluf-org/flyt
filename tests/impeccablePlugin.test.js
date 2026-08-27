import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools, flytApprovals, impeccablePlugin } from '#kernel';

const call = { runId: 'r', blockId: 'b', step: 1, call: { id: 'c', name: 'impeccable_detect', args: { paths: ['src/v2'] } }, ceiling: ['impeccable_detect'] };

test('the detector plugin defaults to the CLI bundled in the provider payload', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(
    new URL('../kernel/src/plugins/impeccable.ts', import.meta.url), 'utf8'));
  assert.match(source, /\.flyt\/skills\/impeccable\/scripts\/detect\.mjs/);
  assert.doesNotMatch(source, /node_modules[\\/]impeccable/);
});

test('Impeccable uses external install, inference, human confirmation and the ordinary ceiling', async () => {
  const kernel = createKernel();
  let proposal;
  try {
    await kernel.ctx.plugin(flytTools);
    await kernel.ctx.plugin(flytApprovals, { mode: 'always' });
    await kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }], {
      import: async () => impeccablePlugin,
    }).then(() => assert.fail('install settled without an attended surface'), error => {
      assert.match(error.message, /attended human classification review/);
    });

    const detach = kernel.pluginReviews.subscribe(() => {});
    const installing = kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }], {
      import: async () => impeccablePlugin,
    });
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
  } finally { await kernel.dispose(); }
});

test('the Loop refuses Impeccable before importing it', async () => {
  const kernel = createKernel({ profile: 'flyt-loop-worker' });
  let imported = false;
  try {
    await assert.rejects(() => kernel.install([{ id: 'impeccable', name: 'impeccable-flyt-plugin' }], {
      import: async () => { imported = true; return impeccablePlugin; },
    }), /attended human classification review/);
    assert.equal(imported, false);
  } finally { await kernel.dispose(); }
});
