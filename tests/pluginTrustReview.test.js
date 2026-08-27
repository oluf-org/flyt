import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools } from '#kernel';
import { buildSurface } from '../src/v2/buildSurface.js';
import {
  declinePluginDecisions, initialPluginDecisions, tightenPluginDecision,
} from '../src/v2/pluginTrustReview.js';

const proposal = {
  name: 'publish_release', effect: 'write', destructive: true, untrustedInput: false,
  requested: ['tools', 'fs'],
  inferredFrom: { seams: ['tools', 'fs'], tool: { name: 'publish_release', description: 'Publishes.' } },
  permits: 'eligible for a later ceiling grant',
  doesNotPermit: 'execution or addition to a ceiling',
};

test('the review editor can only tighten the inference', () => {
  const initial = initialPluginDecisions([proposal]).publish_release;
  assert.deepEqual(initial,
    { effect: 'write', destructive: true, untrustedInput: false, source: 'confirmed' });
  assert.equal(tightenPluginDecision(proposal, initial, { effect: 'shell' }).effect, 'shell');
  assert.equal(tightenPluginDecision(proposal, initial, { untrustedInput: true }).untrustedInput, true);
  assert.throws(() => tightenPluginDecision(proposal, initial, { effect: 'read' }), /only be made stricter/);
  assert.throws(() => tightenPluginDecision(proposal, initial, { destructive: false }), /only be made stricter/);
});

test('decline is explicit and leaves every proposed tool undecided', () => {
  assert.deepEqual(declinePluginDecisions([proposal]), { publish_release: null });
});

test('a real kernel install appears in Build and awaits exactly one decision', async () => {
  const kernel = createKernel({ profile: 'flyt-desktop' });
  let applied = 0;
  try {
    await kernel.ctx.plugin(flytTools);
    const surface = await buildSurface({
      v2Build: async () => ({ stack: { id: 's' }, pluginReviews: kernel.pluginReviews }),
    });
    let revisions = 0;
    const unsubscribe = surface.subscribePluginReview(() => { revisions += 1; });

    const installing = kernel.install([{ id: 'external', name: 'external-package' }], {
      import: async () => ({
        name: 'undeclared-tool-plugin',
        // The object form is Cordis-valid but easy for an array-only boundary
        // to miss. The Loop test separately covers a total omission.
        inject: { tools: {} },
        apply(ctx) {
          applied += 1;
          ctx.tools.register({
            name: 'quiet_tool', description: 'A contributed tool.', parameters: {},
            async execute() { return { content: 'ran' }; },
          });
        },
      }),
    });

    for (let i = 0; i < 20 && !surface.pluginReview; i++) await Promise.resolve();
    const pending = surface.pluginReview;
    assert.equal(applied, 1, 'the attended install runs quarantined to discover its tools');
    assert.equal(pending.pluginName, 'undeclared-tool-plugin');
    assert.deepEqual(pending.proposals.map(p => p.name), ['quiet_tool']);
    assert.equal(kernel.ctx.tools.get('quiet_tool').classification, undefined,
      'it stays unreachable while the modal is pending');

    const decisions = initialPluginDecisions(pending.proposals);
    assert.equal(pending.decide(decisions), true);
    assert.equal(pending.decide(decisions), false, 'a second click cannot settle the pass twice');
    await installing;
    assert.equal(surface.pluginReview, null);
    assert.equal(kernel.ctx.tools.get('quiet_tool').classification.source, 'confirmed');
    assert.ok(revisions >= 2, 'Build is notified when the review appears and when it settles');
    unsubscribe();
  } finally { await kernel.dispose(); }
});
