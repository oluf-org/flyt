import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeToolCalls, ToolCallAccumulator, settleInterruptedToolCalls } from '../core/adapters/transforms/toolCalls.js';
import { classifyCompletion, parseStructuredPayload } from '../core/adapters/transforms/compatibility.js';
import { openAIReplay, replayOpenAIMessage, applyOpenAIRequest } from '../core/adapters/transforms/openai.js';
import { normalizeAnthropicContent, anthropicMessages } from '../core/adapters/transforms/anthropic.js';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/provider-compatibility.json', import.meta.url), 'utf8'));
const offered = ['read_file', 'write_file', 'list_tasks'];

test('provider matrix normalizes native, empty, omitted, stringified, case-mismatched, unknown and multiple calls', () => {
  const calls = normalizeToolCalls([
    fixture.native, fixture.emptyArguments, fixture.omittedArguments, fixture.stringifiedArguments,
    fixture.caseMismatch, fixture.unknown,
  ], offered);
  assert.deepEqual(calls[0].args, { path: 'README.md' });
  assert.deepEqual(calls[1].args, {});
  assert.deepEqual(calls[2].args, {});
  assert.deepEqual(calls[3].args, { path: 'README.md' });
  assert.equal(calls[4].name, 'read_file');
  assert.equal(calls[5].name, 'invented_tool');
  assert.equal(calls.length, 6);
});

test('partial parallel arguments settle by index and interrupted streams retain every partial call', () => {
  const accumulator = new ToolCallAccumulator();
  fixture.partial.forEach(fragment => accumulator.push(fragment));
  assert.deepEqual(accumulator.values().map(call => call.id), ['a', 'b']);
  assert.equal(normalizeToolCalls(accumulator.values(), offered)[1].args.path, 'B');
  assert.deepEqual(settleInterruptedToolCalls(accumulator).map(call => call.state), ['interrupted', 'interrupted']);
});

test('reasoning-only length exhaustion and interrupted empty streams are explicit outcomes', () => {
  assert.equal(classifyCompletion({ reasoning: 'thinking', finishReason: 'length' }).status, 'reasoning_only_length_exhaustion');
  assert.equal(classifyCompletion({ interrupted: true }).status, 'interrupted');
  assert.equal(classifyCompletion({}).status, 'empty_interrupted_stream');
});

test('signed and encrypted reasoning replay survives the provider round trip', () => {
  const encrypted = openAIReplay({ reasoning_details: fixture.encryptedReplay });
  assert.deepEqual(replayOpenAIMessage({ replay: encrypted }).reasoning_details, fixture.encryptedReplay);
  const anthropic = normalizeAnthropicContent(fixture.signedReplay);
  const replayed = anthropicMessages([{ role: 'assistant', content: '', replay: anthropic.replay }]);
  assert.deepEqual(replayed[0].content[0], fixture.signedReplay[0]);
  const toolResult = anthropicMessages([{ role: 'tool', tool_call_id: 'c1', content: 'done' }]);
  assert.deepEqual(toolResult[0].content[0], { type: 'tool_result', tool_use_id: 'c1', content: 'done' });
});

test('structured-output success and failure are diagnostics, not prose parsing guesses', () => {
  const body = { messages: [] };
  applyOpenAIRequest(body, { responseFormat: { name: 'graph', schema: { type: 'object' }, strict: true } });
  assert.equal(body.response_format.type, 'json_schema');
  assert.deepEqual(parseStructuredPayload('{"tasks":[]}').value, { tasks: [] });
  assert.match(parseStructuredPayload('{broken').diagnostics[0], /invalid JSON/);
});
