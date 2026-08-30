import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytTools } from '#kernel';
import { buildSurface } from '../src/v2/buildSurface.js';
import {
  declinePluginDecisions, initialPluginDecisions, pluginInferenceEvidence, tightenPluginDecision,
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

test('the review surface includes every tool input used by inference', () => {
  const evidence = pluginInferenceEvidence({
    requested: ['tools', 'fs'],
    inferredFrom: {
      seams: ['tools', 'fs'],
      tool: {
        name: 'write_note', description: 'Writes a note.',
        parameters: { type: 'object', required: ['text'] },
        classification: { effect: 'write', destructive: true, untrustedInput: false, source: 'declared' },
      },
    },
  });
  assert.equal(evidence.requested, 'tools, fs');
  assert.equal(evidence.seams, 'tools, fs');
  assert.match(evidence.schema, /"required": \[/);
  assert.equal(evidence.claim, 'write + destructive');
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

test('the desktop-shaped bridge carries review data and a separate decision call across IPC', async () => {
  let reviewListener = null;
  let pluginListener = null;
  let decided = null;
  const host = {
    v2Build: async () => ({ stack: { id: 's' }, library: { plugins: [] }, pluginReview: null }),
    v2PluginReview: async () => null,
    v2DecidePluginReview: async decisions => { decided = decisions; return true; },
    onV2PluginReviewChange(listener) { reviewListener = listener; return () => { reviewListener = null; }; },
    onV2PluginsChange(listener) { pluginListener = listener; return () => { pluginListener = null; }; },
  };
  const surface = await buildSurface(host);
  let revisions = 0;
  const detach = surface.subscribePluginReview(() => { revisions += 1; });

  reviewListener({ pluginName: 'desktop-package', proposals: [proposal] });
  assert.equal(surface.pluginReview.pluginName, 'desktop-package');
  await surface.pluginReview.decide({ publish_release: proposal });
  assert.deepEqual(decided, { publish_release: proposal });
  assert.ok(revisions >= 1);
  detach();

  // The catalog is its own subscription, not a side effect of the review one.
  // It used to ride along on `subscribePluginReview`, which meant a manager
  // open on the Library page only heard about installs while a review happened
  // to be wired — and the library object was MUTATED in place, so React never
  // redrew for it either.
  let catalogChanges = 0;
  const detachPlugins = surface.subscribePlugins(() => { catalogChanges += 1; });
  const before = surface.library;
  pluginListener([{ id: 'desktop-package', name: 'Desktop package', installed: true }]);
  assert.equal(surface.library.plugins[0].id, 'desktop-package');
  assert.equal(catalogChanges, 1);
  assert.notEqual(surface.library, before,
    'a catalog edited through the same object is a catalog the renderer cannot see change');
  detachPlugins();
});
