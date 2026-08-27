import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
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

test('Build renders the review facts and both deliberate outcomes', () => {
  const src = rel => fs.readFileSync(fileURLToPath(new URL(`../src/v2/${rel}`, import.meta.url)), 'utf8');
  const shell = src('Shell.jsx');
  const view = src('PluginTrustReview.jsx');
  assert.match(shell, /build\?\.pluginReview\?\.proposals/,
    'the component is wired to the host review seam, not left unreachable');
  for (const fact of ['Plugin requested', 'Inference used', 'Accepting', 'Still not permitted']) {
    assert.match(view, new RegExp(fact), fact);
  }
  assert.match(view, /Keep installed; leave tools unreachable/);
  assert.match(view, /Confirm classifications/);
});
