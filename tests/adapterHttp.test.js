// The real-model path at the HTTP boundary (V1 task 11). The provider adapters
// are the one place the app talks to someone else's API, and they were covered
// only through a fake provider registered in-process — the request they build,
// the SSE they parse, and the key they send had never been asserted.
//
// These stub globalThis.fetch and run the ADAPTERS' real code, so they pin the
// contract without a key or a network. What they deliberately cannot prove is
// live-API drift, real latency, or model behavior — that is the part of task 11
// that needs a user-supplied key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callModel } from '../core/adapters/index.js';
import { runAgent } from '../core/agent.js';

// --- fetch stubbing -------------------------------------------------------

let calls = [];
const realFetch = globalThis.fetch;
function stubFetch(handler) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, headers: init?.headers ?? {}, body });
    return handler({ url, init, body, n: calls.length });
  };
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

// The adapters only ever touch .ok/.status/.json()/.text()/.body.
const jsonRes = (data, { ok = true, status = 200 } = {}) => ({
  ok, status,
  json: async () => data,
  text: async () => JSON.stringify(data)
});
const errRes = (status, text) => ({ ok: false, status, text: async () => text, json: async () => ({}) });
// An SSE stream: sseEvents() iterates the body and parses "data:" lines.
const sseRes = lines => ({
  ok: true, status: 200,
  body: (async function* () {
    const enc = new TextEncoder();
    for (const l of lines) yield enc.encode(`data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`);
  })()
});

test.afterEach(restoreFetch);

// --- OpenRouter -----------------------------------------------------------

test('openrouter: single-shot request shape and response parsing', async () => {
  stubFetch(() => jsonRes({
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2 }
  }));
  const r = await callModel({
    provider: 'openrouter', model: 'x/y', system: 'SYS', prompt: 'P', maxTokens: 111, apiKey: 'sk-test'
  });
  assert.equal(r.text, 'hello');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { prompt_tokens: 5, completion_tokens: 2 });

  const c = calls[0];
  assert.match(c.url, /openrouter\.ai\/api\/v1\/chat\/completions$/);
  assert.equal(c.headers.Authorization, 'Bearer sk-test');
  assert.equal(c.body.model, 'x/y');
  assert.equal(c.body.max_tokens, 111);
  assert.deepEqual(c.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'P' }]);
  assert.ok(!('stream' in c.body), 'must not ask for a stream when no onText was given');
});

test('openrouter: the API key comes from the caller, never the environment', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
  await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'sk-from-settings' });
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-from-settings');
});

test('openrouter: a missing key fails permanently, without a request', async () => {
  stubFetch(() => { throw new Error('must not be called'); });
  await assert.rejects(
    () => callModel({ provider: 'openrouter', model: 'm', prompt: 'p', retry: { attempts: 3, baseMs: 1 } }),
    /API key is not set/);
  assert.equal(calls.length, 0);
});

test('openrouter: streams growing text and reports usage', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo w' } }] },
    { choices: [{ delta: { content: 'orld' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    '[DONE]'
  ]));
  const seen = [];
  const r = await callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: t => seen.push(t)
  });
  assert.equal(calls[0].body.stream, true);
  // onText gets the FULL text so far, not deltas (the contract every consumer
  // relies on to treat each flush as a consistent prefix).
  assert.deepEqual(seen, ['Hel', 'Hello w', 'Hello world']);
  assert.equal(r.text, 'Hello world');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 4 });
});

// OpenRouter only emits the usage chunk when asked; without stream_options
// every streamed call would report null usage and the retrospectives that
// account for tokens would quietly read zero.
test('openrouter: asks for usage when streaming', async () => {
  stubFetch(() => sseRes(['[DONE]']));
  await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: () => {} });
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
});

test('openrouter: a tool-enabled call is not streamed (the loop needs the raw message)', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'x', tool_calls: [] }, finish_reason: 'stop' }] }));
  await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }],
    apiKey: 'k', onText: () => { throw new Error('must not stream'); }
  });
  assert.ok(!calls[0].body.stream, 'streaming must stay off while tools are in play');
  assert.equal(calls[0].body.tools.length, 1);
});

test('openrouter: an HTTP error carries the status, and 429 retries while 401 does not', async () => {
  stubFetch(({ n }) => (n < 3 ? errRes(429, 'slow down') : jsonRes({ choices: [{ message: { content: 'ok' } }] })));
  const r = await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', retry: { attempts: 3, baseMs: 1 } });
  assert.equal(r.text, 'ok');
  assert.equal(r.retries, 2);

  stubFetch(() => errRes(401, 'bad key'));
  await assert.rejects(
    () => callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', retry: { attempts: 3, baseMs: 1 } }),
    /OpenRouter API 401/);
  assert.equal(calls.length, 1, 'a bad key must not be retried');
});

// Real 429s are routine (a live run hit one on the first try), and without this
// a retry left no trace: a recovered call reports only a `retries` count, and an
// exhausted one just throws. "Did backoff run?" was answerable only by timing.
test('onRetry reports every backoff, including the ones that end in failure', async () => {
  stubFetch(() => errRes(429, 'rate limited'));
  const seen = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 3, baseMs: 10 }, onRetry: i => seen.push(i)
  }), /429/);
  // Three attempts, so two backoffs — the last failure throws rather than sleeps.
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(s => s.attempt), [1, 2]);
  assert.equal(seen[0].attempts, 3);
  assert.ok(seen[1].delayMs > seen[0].delayMs, 'backoff must grow');
  assert.match(seen[0].error, /429/);
});

test('onRetry stays silent when a call succeeds first time or fails permanently', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'ok' } }] }));
  const seen = [];
  await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onRetry: i => seen.push(i) });
  assert.deepEqual(seen, []);

  stubFetch(() => errRes(401, 'bad key'));
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 3, baseMs: 1 }, onRetry: i => seen.push(i)
  }), /401/);
  assert.deepEqual(seen, [], 'a permanent error is not a retry');
});

test('openrouter: a response with no choices fails loudly', async () => {
  stubFetch(() => jsonRes({ error: { message: 'nope' } }));
  await assert.rejects(
    () => callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', retry: { attempts: 1 } }),
    /returned no choices/);
});

// --- Anthropic ------------------------------------------------------------

test('anthropic: single-shot request shape and text-block joining', async () => {
  stubFetch(() => jsonRes({
    content: [{ type: 'text', text: 'part one ' }, { type: 'thinking', text: 'ignore me' }, { type: 'text', text: 'part two' }],
    usage: { input_tokens: 9, output_tokens: 3 }
  }));
  const r = await callModel({
    provider: 'anthropic', model: 'claude-x', system: 'SYS', prompt: 'P', maxTokens: 222, apiKey: 'sk-ant-test'
  });
  assert.equal(r.text, 'part one part two'); // non-text blocks dropped
  assert.deepEqual(r.usage, { input_tokens: 9, output_tokens: 3 });

  const c = calls[0];
  assert.match(c.url, /api\.anthropic\.com\/v1\/messages$/);
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.body.model, 'claude-x');
  assert.equal(c.body.max_tokens, 222);
  assert.equal(c.body.system, 'SYS');
  assert.deepEqual(c.body.messages, [{ role: 'user', content: 'P' }]);
});

// The BYO-key contract (D18): a key saved in the app must reach the adapter.
// callModel has always passed one; the adapter used to read only the process
// environment and drop it, so a key entered in the app did nothing.
test('anthropic: uses the caller-supplied key (BYO-key), not just the environment', async () => {
  stubFetch(() => jsonRes({ content: [{ type: 'text', text: 'ok' }] }));
  await callModel({ provider: 'anthropic', model: 'm', prompt: 'p', apiKey: 'sk-ant-from-settings' });
  assert.equal(calls[0].headers['x-api-key'], 'sk-ant-from-settings');
});

test('anthropic: falls back to ANTHROPIC_API_KEY when no key is passed', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env';
  try {
    stubFetch(() => jsonRes({ content: [{ type: 'text', text: 'ok' }] }));
    await callModel({ provider: 'anthropic', model: 'm', prompt: 'p' });
    assert.equal(calls[0].headers['x-api-key'], 'sk-ant-from-env');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('anthropic: an explicit key wins over the environment', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-env';
  try {
    stubFetch(() => jsonRes({ content: [{ type: 'text', text: 'ok' }] }));
    await callModel({ provider: 'anthropic', model: 'm', prompt: 'p', apiKey: 'sk-ant-explicit' });
    assert.equal(calls[0].headers['x-api-key'], 'sk-ant-explicit');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('anthropic: no key anywhere fails permanently, without a request', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    stubFetch(() => { throw new Error('must not be called'); });
    await assert.rejects(
      () => callModel({ provider: 'anthropic', model: 'm', prompt: 'p', retry: { attempts: 3, baseMs: 1 } }),
      /API key is not set/);
    assert.equal(calls.length, 0);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('anthropic: streams text deltas and merges usage across events', async () => {
  stubFetch(() => sseRes([
    { type: 'message_start', message: { usage: { input_tokens: 11 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Ada ' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Lovelace' } },
    { type: 'message_delta', usage: { output_tokens: 4 } },
    { type: 'message_stop' }
  ]));
  const seen = [];
  const r = await callModel({ provider: 'anthropic', model: 'm', prompt: 'p', apiKey: 'k', onText: t => seen.push(t) });
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(seen, ['Ada ', 'Ada Lovelace']);
  assert.equal(r.text, 'Ada Lovelace');
  // input from message_start, output from message_delta: both halves survive.
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 4 });
});

test('anthropic: a mid-stream error event is surfaced, not swallowed', async () => {
  stubFetch(() => sseRes([
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } },
    { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }
  ]));
  await assert.rejects(
    () => callModel({ provider: 'anthropic', model: 'm', prompt: 'p', apiKey: 'k', onText: () => {}, retry: { attempts: 1 } }),
    /stream error/);
});

test('anthropic: HTTP errors carry the status for retry classification', async () => {
  stubFetch(({ n }) => (n < 2 ? errRes(529, 'overloaded') : jsonRes({ content: [{ type: 'text', text: 'ok' }] })));
  const r = await callModel({ provider: 'anthropic', model: 'm', prompt: 'p', apiKey: 'k', retry: { attempts: 2, baseMs: 1 } });
  assert.equal(r.text, 'ok');
  assert.equal(r.retries, 1);
});

// --- native tool-calling over a real adapter ------------------------------

// The NATIVE path (task 11 names it explicitly): only reachable on OpenRouter
// with a tools-capable model, so the mock provider can never exercise it.
test('native tool-calling: the agent loop drives a real OpenRouter round trip', async () => {
  const store = {
    appendLog: () => {},
    writeTaskSpec: () => 'tasks/task-1.spec.md'
  };
  stubFetch(({ n }) => (n === 1
    ? jsonRes({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'write_task_md', arguments: JSON.stringify({ content: '# Spec' }) }
          }]
        }
      }]
    })
    : jsonRes({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'All done.' } }] })));

  const { getTools } = await import('../core/tools/index.js');
  const out = await runAgent({
    worker: { provider: 'openrouter', model: 'tool-model', supportsTools: true },
    apiKey: 'k',
    system: 'SYS', prompt: 'P',
    tools: getTools(['write_task_md']),
    ctx: { store, runId: 'r1', taskId: 'task-1' }
  });

  assert.equal(out.text, 'All done.');
  assert.equal(out.toolCalls.length, 1);
  assert.equal(out.toolCalls[0].tool, 'write_task_md');
  assert.equal(out.toolCalls[0].ok, true);

  // Turn 2 must echo the assistant's tool_calls back and answer each one with a
  // role:'tool' message keyed by id — get this wrong and the provider 400s.
  const second = calls[1].body.messages;
  assert.equal(second.at(-2).role, 'assistant');
  assert.equal(second.at(-2).tool_calls[0].id, 'call_1');
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'call_1');
  assert.equal(calls[1].body.tools.length, 1, 'tools must stay declared on every turn');
});

test('native tool-calling: a failed tool comes back to the model instead of killing the run', async () => {
  const store = { appendLog: () => {} };
  stubFetch(({ n }) => (n === 1
    ? jsonRes({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_task_md', arguments: '{ not json' } }]
        }
      }]
    })
    : jsonRes({ choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }] })));

  const { getTools } = await import('../core/tools/index.js');
  const out = await runAgent({
    worker: { provider: 'openrouter', model: 'tool-model', supportsTools: true },
    apiKey: 'k', system: 'S', prompt: 'P',
    tools: getTools(['write_task_md']),
    ctx: { store, runId: 'r1', taskId: 'task-1' }
  });
  assert.equal(out.text, 'recovered');
  assert.equal(out.toolCalls[0].ok, false);
  assert.match(JSON.parse(calls[1].body.messages.at(-1).content).error, /not valid JSON/);
});
