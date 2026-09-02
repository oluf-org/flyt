import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultModelCapabilityRegistry, manageContextBudget, unknownCapability,
  assertToolTransition, normalizeToolCall, reconcileToolCallStates,
} from '#kernel';

const assertFact = fact => {
  assert.ok(fact && Object.hasOwn(fact, 'value'));
  assert.ok(['verified', 'reported', 'inferred', 'unknown'].includes(fact.confidence));
  assert.equal(typeof fact.source, 'string');
  assert.ok(fact.source.length > 0);
};

test('the registry has attributed facts for every capability category, including explicit unknowns', () => {
  for (const profile of [defaultModelCapabilityRegistry.get('gpt-5.6-sol', 'openai'), unknownCapability('mystery', 'relay')]) {
    assertFact(profile.provenance);
    Object.values(profile.limits).forEach(assertFact);
    Object.values(profile.modalities).forEach(assertFact);
    Object.values(profile.tools).forEach(assertFact);
    Object.values(profile.structuredOutput).forEach(assertFact);
    Object.values(profile.reasoning).forEach(assertFact);
    Object.values(profile.pricing).forEach(assertFact);
    Object.values(profile.cache).forEach(assertFact);
    assertFact(profile.providerOverheadTokens);
  }
});

test('context manager records requested/model/provider/effective values and preserves the original messages', () => {
  const profile = unknownCapability('small', 'test');
  profile.limits.contextTokens = { value: 1200, confidence: 'verified', source: 'fixture' };
  profile.limits.maxOutputTokens = { value: 200, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 16, confidence: 'verified', source: 'fixture' };
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'tool', name: 'read_file', toolCallId: '1', handle: '@tool:1', content: 'a'.repeat(1200) },
    { role: 'tool', name: 'read_file', toolCallId: '2', handle: '@tool:2', content: 'b'.repeat(1200) },
    ...Array.from({ length: 12 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `turn-${index} ${'x'.repeat(240)}` })),
  ];
  const before = structuredClone(messages);
  const decision = manageContextBudget({ messages, requestedOutput: 500, profile });
  assert.deepEqual(messages, before, 'the canonical trace input is never mutated');
  assert.ok(decision.effective.total <= decision.contextLimit);
  assert.ok(decision.actions.some(action => action.action === 'prune_superseded_tool_previews'));
  assert.ok(decision.actions.some(action => action.action === 'durable_compaction_checkpoint'));
  assert.deepEqual(decision.resolutions.map(item => item.field), ['context_tokens', 'max_output_tokens']);
  assert.equal(decision.resolutions[1].requested, 500);
  assert.equal(decision.resolutions[1].modelLimit, 200);
  assert.equal(decision.resolutions[1].effective, decision.effectiveOutput);
});

test('context compaction restores output room instead of freezing an early one-token clamp', () => {
  const profile = unknownCapability('small', 'test');
  profile.limits.contextTokens = { value: 2_000, confidence: 'verified', source: 'fixture' };
  profile.limits.maxOutputTokens = { value: 500, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 0, confidence: 'verified', source: 'fixture' };
  const messages = [
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user', content: `old-${index} ${'x'.repeat(1_000)}`,
    })),
    { role: 'user', content: 'Answer this recent question.' },
  ];

  const decision = manageContextBudget({ messages, requestedOutput: 500, profile });
  assert.ok(decision.actions.some(action => action.action === 'retain_recent_turns'));
  assert.equal(decision.effectiveOutput, 500,
    'space reclaimed from old turns is available to the answer');
  assert.ok(decision.effective.total <= decision.contextLimit);
});

test('canonical tool-call state rules normalize once and identify restart reconciliation targets', () => {
  assert.doesNotThrow(() => assertToolTransition(null, 'received'));
  assert.doesNotThrow(() => assertToolTransition('running', 'completed'));
  assert.throws(() => assertToolTransition('received', 'running'));
  assert.deepEqual(normalizeToolCall({ id: 'c', name: 'Read_File', args: '{"path":"x"}' }, ['read_file']), {
    id: 'c', name: 'read_file', args: { path: 'x' },
  });
  const rows = reconcileToolCallStates([
    { seq: 1, at: '', type: 'tool.state', data: { callId: 'a', state: 'received' } },
    { seq: 2, at: '', type: 'tool.state', data: { callId: 'a', state: 'running' } },
    { seq: 3, at: '', type: 'tool.state', data: { callId: 'b', state: 'completed' } },
  ]);
  assert.deepEqual(rows, [{ callId: 'a', state: 'running' }, { callId: 'b', state: 'completed' }]);
});
