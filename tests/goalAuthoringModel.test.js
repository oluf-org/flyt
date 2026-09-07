import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { createAuthoringModelCaller } from '../core/goalAuthoringModel.js';
import { AUTHORING_RESPONSE_FORMAT, decodeAuthoringResponse } from '../core/goalAuthoringProtocol.js';

const target = { provider: 'openrouter', model: 'test/model', apiKey: 'test-key' };
const request = { target, system: 'Return JSON', prompt: 'Explain this loop' };
const realFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = realFetch; });

test('real adapter sends strict schema with streaming and requires a capable OpenRouter endpoint', async () => {
  const output = { type: 'message', text: 'Explanation', rationale: null, name: null, operations: null, arguments: null };
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const chunks = [{ choices: [{ delta: { reasoning: 'private thought' } }] },
      { choices: [{ delta: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { cost: 0.001, prompt_tokens: 10, completion_tokens: 20 } }, '[DONE]'];
    return { ok: true, status: 200, body: (async function* () { for (const chunk of chunks) yield new TextEncoder().encode(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`); })() };
  };
  const progress = [], records = [];
  const call = createAuthoringModelCaller();
  const result = await call({ ...request, facts: { supportedParameters: ['structured_outputs'] }, onText: (text, meta) => progress.push(meta), onCall: record => records.push(record) });
  assert.equal(sent.stream, true); assert.equal(sent.provider.require_parameters, true);
  assert.equal(sent.response_format.type, 'json_schema'); assert.equal(sent.response_format.json_schema.strict, true);
  assert.deepEqual(sent.response_format.json_schema.schema, AUTHORING_RESPONSE_FORMAT.schema);
  assert.match(sent.messages[0].content, /valueJson/); assert.equal(sent.tools, undefined);
  assert.equal(result.finishReason, 'stop'); assert.equal(progress.at(-1).content, JSON.stringify(output));
  assert.equal(records[0].responseMode, 'json_schema'); assert.equal(records[0].httpStatus, 200);
  assert.equal(JSON.stringify(records).includes('test-key'), false);
  const validate = new Ajv({ strict: false }).compile(AUTHORING_RESPONSE_FORMAT.schema);
  assert.equal(validate(output), true); assert.equal(validate({ type: 'message', text: 'missing required fields' }), false);
  assert.deepEqual(decodeAuthoringResponse(output), { type: 'message', text: 'Explanation' });
});

test('JSON-only models receive JSON mode; unsupported adapters keep prompt validation', async () => {
  const seen = [];
  const call = createAuthoringModelCaller({ call: async args => { seen.push(args); return { text: '{}' }; } });
  await call({ ...request, facts: { supported_parameters: ['response_format'] } });
  await call({ ...request, target: { provider: 'anthropic', model: 'test' } });
  assert.deepEqual(seen[0].responseFormat, { type: 'json_object' }); assert.equal(seen[0].requireParameters, true);
  assert.equal(seen[1].responseFormat, undefined); assert.equal(seen[1].requireParameters, undefined);
});

test('missing saved capabilities use cached public metadata without sending credentials or prompts', async () => {
  let fetches = 0;
  const seen = [];
  const call = createAuthoringModelCaller({ fetchCatalog: async signal => {
    fetches++; assert(signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ data: [{ id: target.model, supported_parameters: ['structured_outputs'] }] }) };
  }, call: async args => { seen.push(args); return { text: '{}' }; } });
  await call(request); await call(request);
  assert.equal(fetches, 1); assert.equal(seen[0].responseFormat.name, 'goal_authoring_response');
});

test('catalogue failures fall back explicitly; correction has a smaller bounded budget', async () => {
  const seen = [], formats = [];
  const call = createAuthoringModelCaller({ fetchCatalog: async () => { throw new Error('Metadata unavailable'); }, call: async args => { seen.push(args); return { text: '{}' }; } });
  await call({ ...request, correction: true, onFormat: format => formats.push(format) });
  assert.equal(formats[0].mode, 'prompt'); assert.match(formats[0].capabilityError, /Metadata unavailable/);
  assert.equal(seen[0].responseFormat, undefined); assert.equal(seen[0].maxTokens, 4096);
  assert.deepEqual(seen[0].timeout, { idleMs: 90000, hardMs: 90000 }); assert.equal(seen[0].retry.attempts, 1);
});

test('format support failures are marked for counted fallback; schema and auth failures are not', async () => {
  for (const [text, expected] of [
    ['OpenRouter API 400: response_format json_schema is not supported', true],
    ['OpenRouter API 404: No endpoints support structured_outputs', true],
    ['OpenRouter API 400: invalid schema in response_format', false],
    ['OpenRouter API 401: authentication failed', false],
    ['OpenRouter call exceeded its 180s ceiling', false],
  ]) {
    let calls = 0;
    const call = createAuthoringModelCaller({ call: async () => { calls++; throw new Error(text); } });
    await assert.rejects(call({ ...request, facts: { supportedParameters: ['structured_outputs'] } }), error => Boolean(error.authoringFormatUnsupported) === expected);
    assert.equal(calls, 1, 'no hidden provider retries');
  }
});

test('JSON mode is serialized at the real OpenRouter wire boundary', async () => {
  let body;
  globalThis.fetch = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"type":"message","text":"ok"}' }, finish_reason: 'stop' }] }) };
  };
  await createAuthoringModelCaller()({ ...request, facts: { supportedParameters: ['response_format'] } });
  assert.deepEqual(body.response_format, { type: 'json_object' }); assert.equal(body.provider.require_parameters, true);
});

test('native string replacements preserve multiline YAML without nested JSON escaping', () => {
  const yaml = 'version: 2\nblocks:\n  - id: audit\n    instructions: |\n      Report "confirmed" findings.\n      Save under findings/.\n';
  const output = { type: 'proposal', text: null, rationale: 'Audit', name: null, arguments: null,
    operations: [
      { op: 'replace', address: 'recipe', valueText: yaml, valueJson: null },
      { op: 'replace', address: 'goal/criteria', valueText: null, valueJson: '[{"type":"file_contains","path":"findings/summary.md","value":"Reviewed areas"}]' },
      { op: 'replace', address: 'setup', valueText: null, valueJson: 'null' },
    ] };
  assert.equal(new Ajv({ strict: false }).compile(AUTHORING_RESPONSE_FORMAT.schema)(output), true);
  const decoded = decodeAuthoringResponse(JSON.parse(JSON.stringify(output)));
  assert.equal(decoded.operations[0].value, yaml);
  assert.equal(decoded.operations[1].value[0].path, 'findings/summary.md');
  assert.equal(decoded.operations[2].value, null);
  for (const fields of [{ valueText: 'a', valueJson: '1' }, { valueText: null, valueJson: null }, { valueText: 1, valueJson: null }]) {
    assert.throws(() => decodeAuthoringResponse({ operations: [{ op: 'replace', address: 'recipe', ...fields }] }), /Ambiguous|must/);
  }
  assert.throws(() => decodeAuthoringResponse({ operations: [{ address: 'recipe', valueJson: 'version: 2' }] }), /Invalid valueJson at recipe.*valueText/);
});
