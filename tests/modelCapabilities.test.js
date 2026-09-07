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

test('application context limit compacts parallel tool batches without orphaned results', () => {
  const messages = [{ role: 'system', content: 'Fixed audit constraints' }, { role: 'user', content: 'Audit the local app' }];
  for (let round = 0; round < 12; round++) {
    const calls = Array.from({ length: 6 }, (_, index) => ({ id: `read-${round}-${index}`, name: 'read_file', args: { path: `file-${round}-${index}` } }));
    messages.push({ role: 'assistant', content: `Observed finding ${round}`, toolCalls: calls });
    for (const call of calls) messages.push({ role: 'tool', name: call.name, toolCallId: call.id, handle: `@tool:${call.id}`, content: '\"\\\n'.repeat(6000) });
  }
  const before = structuredClone(messages);
  const decision = manageContextBudget({ messages, profile: unknownCapability('large', 'test'), requestedOutput: 4096, maxMessageChars: 96000 });
  assert(JSON.stringify(decision.messages).length <= 96000);
  assert.deepEqual(messages, before, 'full evidence stays immutable');
  assert(decision.actions.some(action => action.action === 'bound_tool_previews'));
  const latest = decision.messages.find(message => message.toolCalls?.some(call => call.id === 'read-11-0'));
  assert(latest, 'the latest assistant call batch survives');
  for (const call of latest.toolCalls) assert(decision.messages.some(message => message.toolCallId === call.id));
  for (const result of decision.messages.filter(message => message.role === 'tool')) {
    assert(decision.messages.some(message => message.toolCalls?.some(call => call.id === result.toolCallId)));
  }
  assert.equal(decision.effectiveOutput, 4096);
  assert.match(decision.checkpoint, /Observed finding/);
});

test('unshrinkable fixed instructions fail before dispatch with an actionable context error', () => {
  assert.throws(() => manageContextBudget({ messages: [{ role: 'system', content: 'x'.repeat(100000) }],
    profile: unknownCapability('large', 'test'), maxMessageChars: 96000 }), /instructions.*96000-character application limit/);
});

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

test('context pruning preserves distinct queries made through the same read tool', () => {
  const profile = unknownCapability('small', 'test');
  profile.limits.contextTokens = { value: 1_200, confidence: 'verified', source: 'fixture' };
  profile.limits.maxOutputTokens = { value: 200, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 0, confidence: 'verified', source: 'fixture' };
  const calls = [
    { id: 'search-a', name: 'search_files', args: { glob: 'a.ts', pattern: 'offset' } },
    { id: 'search-b', name: 'search_files', args: { glob: 'a.ts', pattern: 'nextOffset' } },
  ];
  const messages = [
    { role: 'user', content: 'Inspect the pagination implementation.' },
    { role: 'assistant', content: '', toolCalls: calls },
    { role: 'tool', name: 'search_files', toolCallId: 'search-a', content: `offset evidence ${'a'.repeat(1_200)}` },
    { role: 'tool', name: 'search_files', toolCallId: 'search-b', content: `nextOffset evidence ${'b'.repeat(1_200)}` },
  ];

  const decision = manageContextBudget({ messages, requestedOutput: 200, profile });
  assert.ok(!decision.actions.some(action => action.action === 'prune_superseded_tool_previews'),
    'different argument fingerprints are independent evidence, not superseded previews');
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

test('worker checkpoint threshold compacts before the provider context ceiling', () => {
  const profile = unknownCapability('large', 'test');
  profile.limits.contextTokens = { value: 100_000, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 0, confidence: 'verified', source: 'fixture' };
  const messages = Array.from({ length: 16 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: `${index} ${'x'.repeat(1_000)}`,
  }));
  const decision = manageContextBudget({ messages, requestedOutput: 500, checkpointInputTokens: 2_000, profile });
  assert.ok(decision.actions.some(action => action.action === 'durable_compaction_checkpoint'));
  assert.match(decision.checkpoint, /Completed findings:/);
  assert.match(decision.checkpoint, /Remaining work:/);
  assert.ok(decision.requested.total < decision.contextLimit, 'checkpointing is proactive, not an overflow repair');
});

test('context compaction retains the original worker assignment as a user-role anchor', () => {
  const profile = unknownCapability('large', 'test');
  profile.limits.contextTokens = { value: 100_000, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 0, confidence: 'verified', source: 'fixture' };
  const assignment = 'Audit the workflow block library; do not follow unrelated project context.';
  const messages = [
    { role: 'system', content: 'worker contract' },
    { role: 'user', content: assignment },
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'tool',
      ...(index % 2 ? {} : { name: 'glob', toolCallId: `call-${index}` }),
      content: `old-${index} ${'x'.repeat(1_000)}`,
    })),
    { role: 'assistant', content: 'I should continue from the evidence.' },
  ];

  const decision = manageContextBudget({
    messages, requestedOutput: 500, checkpointInputTokens: 2_000, profile,
  });
  const anchor = decision.messages.find(message => message.role === 'user'
    && message.content.startsWith('Original assignment (authoritative'));
  assert.ok(anchor, 'the compacted request retains a user-role assignment anchor');
  assert.match(anchor.content, new RegExp(assignment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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

test('a compaction checkpoint names the calls whose results were compacted', async () => {
  const { describeInspectedCalls } = await import('#kernel');
  const profile = unknownCapability('large', 'test');
  profile.limits.contextTokens = { value: 100_000, confidence: 'verified', source: 'fixture' };
  profile.providerOverheadTokens = { value: 0, confidence: 'verified', source: 'fixture' };
  const turn = (index, call) => [
    { role: 'assistant', content: `finding ${index}`, toolCalls: [call] },
    { role: 'tool', name: call.name, toolCallId: call.id, content: `${index} ${'x'.repeat(3_000)}` },
    { role: 'user', content: `next ${index}` },
  ];
  const messages = [
    { role: 'user', content: 'Trace the submit path.' },
    ...turn(1, { id: 'a', name: 'read_file', args: { path: 'src/Lander.jsx' } }),
    ...turn(2, { id: 'b', name: 'glob', args: { pattern: 'src/**/*.jsx' } }),
    ...turn(3, { id: 'c', name: 'read_file', args: { path: 'src/Lander.jsx' } }),
    ...turn(4, { id: 'd', name: 'read_file', args: { path: 'src/v2/DailyRoot.jsx', offset: 300 } }),
    ...Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `tail ${index}` })),
  ];
  const decision = manageContextBudget({ messages, requestedOutput: 500, checkpointInputTokens: 1_500, profile });
  assert.ok(decision.actions.some(action => action.action === 'durable_compaction_checkpoint'));
  assert.match(decision.checkpoint, /Already inspected .*read_file\(src\/Lander\.jsx\), glob\(src\/\*\*\/\*\.jsx\), read_file\(src\/v2\/DailyRoot\.jsx@300\)/,
    'compacted reads are listed once each, in order, with their page offset');
  assert.deepEqual(describeInspectedCalls([
    { role: 'assistant', content: '', toolCalls: Array.from({ length: 50 }, (_, index) => ({ id: String(index), name: 'read_file', args: { path: `f${index}` } })) },
  ]).slice(0, 2), ['+2 earlier', 'read_file(f2)'], 'a long list keeps the most recent calls and counts the rest');
});
