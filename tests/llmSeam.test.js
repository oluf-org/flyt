// `ctx.llm` over the adapters that already exist.
//
// The seam was declared in Phase 0 and never provided, so nothing on the v2
// kernel could reach a model at all. This is the bridge, and it is deliberately
// thin: `core/adapters/` already holds the retry budget, the idle deadline, the
// streamed-character accounting and the aborted-spend record, and a second
// implementation of any of that would be a second set of bugs in the same
// shape.
//
// Two things it does add, and both are tested here: the route record, and
// turning the adapters' WHOLE-TURN emissions into deltas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createKernel, flytAdapters, routeOf } from '#kernel';

const request = over => ({ model: 'a/model', messages: [{ role: 'user', content: 'hi' }], ...over });

async function bootLlm({ answer = {}, resolve = null, capture = null } = {}) {
  const kernel = createKernel();
  const seen = [];
  await kernel.ctx.plugin(flytAdapters, {
    resolve: resolve ?? (model => ({ provider: 'openrouter', model, apiKey: 'k' })),
    async callModel(req) {
      seen.push(req);
      if (capture) await capture(req);
      return { text: 'done', finishReason: 'stop', provider: 'openrouter', model: req.model, ...answer };
    },
  });
  return { kernel, seen };
}

test('a request reaches the adapter with its provider, key and tools resolved', async () => {
  const boot = await bootLlm();
  const answer = await boot.kernel.ctx.llm.complete(request({
    tools: [{ name: 'peek', description: 'Look.', parameters: { type: 'object' } }],
    maxTokens: 1024,
  }));
  assert.equal(answer.content, 'done');
  assert.equal(answer.finishReason, 'stop');

  const sent = boot.seen[0];
  assert.equal(sent.provider, 'openrouter');
  assert.equal(sent.apiKey, 'k');
  assert.equal(sent.maxTokens, 1024);
  assert.deepEqual(sent.tools, [{
    type: 'function',
    function: { name: 'peek', description: 'Look.', parameters: { type: 'object' } },
  }], 'OpenAI-shaped, which is what every adapter here speaks');
  await boot.kernel.dispose();
});

test('a model nothing can serve is refused, naming it', async () => {
  const boot = await bootLlm({ resolve: () => null });
  await assert.rejects(() => boot.kernel.ctx.llm.complete(request({ model: 'nobody/knows' })),
    /No connected provider can serve "nobody\/knows"/);
  await boot.kernel.dispose();
});

test('tool calls arrive parsed, and one that will not parse is still a call', async () => {
  const boot = await bootLlm({
    answer: {
      text: '', finishReason: 'tool_calls',
      message: {
        tool_calls: [
          { id: 'c1', function: { name: 'peek', arguments: '{"at":"x"}' } },
          { id: 'c2', function: { name: 'bash', arguments: '{oh no' } },
        ],
      },
    },
  });
  const answer = await boot.kernel.ctx.llm.complete(request());
  assert.deepEqual(answer.toolCalls[0], { id: 'c1', name: 'peek', args: { at: 'x' } });
  assert.equal(answer.toolCalls[1].name, 'bash');
  assert.deepEqual(answer.toolCalls[1].args, { _unparsed: '{oh no' },
    'the gate has to see a call the model made, however badly it made it');
  await boot.kernel.dispose();
});

test('the route record says what answered, and whether that is what was asked for', () => {
  assert.deepEqual(
    routeOf('a/model', { provider: 'openrouter', model: 'a/model' }),
    {
      requested: 'a/model',
      effective: 'openrouter/a/model',
      reason: 'the model asked for is the model that answered',
      degraded: false,
    });

  // The Auto Router answers as something else, and that is the only place it
  // says which.
  const auto = routeOf('openrouter/auto', { provider: 'openrouter', model: 'openrouter/auto', resolvedModel: 'x/big' });
  assert.equal(auto.effective, 'openrouter/x/big');
  assert.equal(auto.degraded, true, 'a fallback that renders like a success is the thing Trace exists to prevent');

  // A reason the resolver gave wins over the generic one: it knows why.
  assert.equal(
    routeOf('a/model', { provider: 'kimi', model: 'a/model' }, 'openrouter had no key').reason,
    'openrouter had no key');
});

test('usage is mapped into the kernel’s shape, reasoning tokens included', async () => {
  const boot = await bootLlm({
    answer: {
      usage: {
        prompt_tokens: 900, completion_tokens: 120, cost: 0.004,
        completion_tokens_details: { reasoning_tokens: 80 },
        prompt_tokens_details: { cached_tokens: 400 },
      },
    },
  });
  const answer = await boot.kernel.ctx.llm.complete(request());
  assert.deepEqual(answer.usage, {
    promptTokens: 900, completionTokens: 120, reasoningTokens: 80, cachedTokens: 400, costUsd: 0.004,
  });
  await boot.kernel.dispose();
});

test('a stream yields deltas, because the adapters deliver the whole turn each time', async () => {
  // The adapters call `onText` with the WHOLE turn so far, not with the new
  // part. A consumer that concatenated what it was handed would count the turn
  // quadratically — and would render "HeHelHellHello".
  const boot = await bootLlm({
    answer: { text: 'Hello there' },
    async capture(req) {
      req.onText?.('He');
      req.onText?.('Hello');
      req.onText?.('Hello there');
    },
  });

  const stream = boot.kernel.ctx.llm.stream(request());
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk.text);
  assert.deepEqual(chunks, ['He', 'llo', ' there'], 'the difference, not the total');
  assert.equal(chunks.join(''), 'Hello there');

  const settled = await stream.settled();
  assert.equal(settled.content, 'Hello there');
  assert.equal(settled.finishReason, 'stop');
  assert.ok(settled.route, 'and the whole record, which is why a stream settles at all');
  await boot.kernel.dispose();
});

test('a stream that fails throws where the caller is looking, not into the void', async () => {
  const kernel = createKernel();
  await kernel.ctx.plugin(flytAdapters, {
    resolve: model => ({ provider: 'openrouter', model }),
    async callModel() { throw new Error('the provider said no'); },
  });
  const stream = kernel.ctx.llm.stream(request());
  await assert.rejects(async () => { for await (const _ of stream) { /* drain */ } },
    /the provider said no/);
  await assert.rejects(() => stream.settled(), /the provider said no/);
  await kernel.dispose();
});
