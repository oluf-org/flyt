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
import fs from 'node:fs';
import path from 'node:path';

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
  assert.deepEqual(seen.slice(0, 3), ['Hel', 'Hello w', 'Hello world']);
  // ...and the last emit is always repeated as `final`, because the adapter
  // cannot know whether the consumer throttled the identical one away.
  assert.equal(seen.at(-1), 'Hello world');
  assert.equal(r.text, 'Hello world');
  assert.equal(r.finishReason, 'stop');
  assert.deepEqual(r.usage, { prompt_tokens: 3, completion_tokens: 4 });
});

// OpenRouter only emits the usage chunk when asked; without stream_options
// every streamed call would report null usage and the retrospectives that
// account for tokens would quietly read zero.
test('openrouter: asks for usage when streaming', async () => {
  stubFetch(() => sseRes([{ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }, '[DONE]']));
  await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: () => {} });
  assert.deepEqual(calls[0].body.stream_options, { include_usage: true });
});

// Without onText there is nobody watching, so there is nothing to stream for —
// the simpler non-streaming response is used, tools or not.
test('openrouter: a call with no onText is not streamed, tools or not', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'x', tool_calls: [] }, finish_reason: 'stop' }] }));
  await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }],
    apiKey: 'k'
  });
  assert.ok(!calls[0].body.stream);
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

// --- Retry-After: listening to the provider instead of guessing ------------

const withHeaders = (status, body, headers) => ({
  ok: false, status,
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  text: async () => body, json: async () => ({})
});

test('a Retry-After header overrides a shorter guessed backoff', async () => {
  stubFetch(() => withHeaders(429, 'slow down', { 'retry-after': '7' }));
  const seen = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 2, baseMs: 1, maxMs: 60000 }, onRetry: i => { seen.push(i); throw new Error('stop'); }
  }), /stop|429/);
  assert.equal(seen[0].retryAfterMs, 7000);
  assert.equal(seen[0].delayMs, 7000, 'the provider knows when its window reopens; we do not');
});

// OpenRouter is a gateway: an upstream 429 arrives with the hint in the BODY,
// not as a header. This is the exact shape a live run returned.
test('an upstream hint nested in the error body is honored too', async () => {
  const body = JSON.stringify({
    error: { message: 'Provider returned error', code: 429, metadata: { raw: 'rate-limited upstream', retry_after_seconds: 3 } }
  });
  stubFetch(() => withHeaders(429, body, {}));
  const seen = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 2, baseMs: 1, maxMs: 60000 }, onRetry: i => { seen.push(i); throw new Error('stop'); }
  }), /stop|429/);
  assert.equal(seen[0].retryAfterMs, 3000);
});

test('a hint shorter than the backoff does not shrink it', async () => {
  stubFetch(() => withHeaders(429, 'x', { 'retry-after': '1' }));
  const seen = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 2, baseMs: 5000, maxMs: 60000 }, onRetry: i => { seen.push(i); throw new Error('stop'); }
  }), /stop|429/);
  assert.ok(seen[0].delayMs >= 5000, 'backoff still applies when the hint is shorter');
});

// A provider asking for an hour must not be able to park a run for one.
test('maxMs caps an outsized Retry-After', async () => {
  stubFetch(() => withHeaders(429, 'x', { 'retry-after': '3600' }));
  const seen = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 2, baseMs: 1, maxMs: 250 }, onRetry: i => { seen.push(i); throw new Error('stop'); }
  }), /stop|429/);
  assert.equal(seen[0].delayMs, 250);
});

test('parseRetryAfter handles the HTTP-date form and absent/garbage hints', async () => {
  const { parseRetryAfter } = await import('../core/adapters/http.js');
  const hdr = v => ({ headers: { get: k => (k.toLowerCase() === 'retry-after' ? v : null) } });
  const at = new Date(Date.now() + 5000).toUTCString();
  const ms = parseRetryAfter(hdr(at), '');
  assert.ok(ms > 3000 && ms <= 5000, `HTTP-date should resolve to ~5s, got ${ms}`);
  assert.equal(parseRetryAfter(hdr(null), 'not json'), null);
  assert.equal(parseRetryAfter({}, ''), null);
  assert.equal(parseRetryAfter(hdr('nonsense'), '{}'), null);
});

test('the shipped retry budget is 5 attempts, and config.json exposes it', async () => {
  const { DEFAULT_RETRY } = await import('../core/adapters/index.js');
  assert.equal(DEFAULT_RETRY.attempts, 5);
  const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config.json'), 'utf8'));
  assert.deepEqual(cfg.retry, DEFAULT_RETRY, 'config.json must ship the same policy the code defaults to');
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
  assert.deepEqual(seen.slice(0, 2), ['Ada ', 'Ada Lovelace']);
  assert.equal(seen.at(-1), 'Ada Lovelace'); // always re-emitted as final
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

// --- an empty response is a failure, not a success ------------------------

// A live run spent 103s on a stream that delivered nothing, and the node was
// recorded 'success' with a 0-byte artifact and null usage — then fed that
// emptiness downstream. The mock always answers, so only a real provider could
// surface this (V1 task 11).
test('openrouter: a stream that delivers nothing is a transient failure, not an empty answer', async () => {
  stubFetch(() => sseRes(['[DONE]']));
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    onText: () => {}, retry: { attempts: 1 }
  }), /ended without any content/);
});

test('openrouter: an empty completion WITH a finish reason is a real answer, and stands', async () => {
  stubFetch(() => sseRes([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']));
  const r = await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: () => {}, retry: { attempts: 1 } });
  assert.equal(r.text, '');
  assert.equal(r.finishReason, 'stop');
});

test('an empty stream is retried, and recovers', async () => {
  stubFetch(({ n }) => (n === 1
    ? sseRes(['[DONE]'])
    : sseRes([{ choices: [{ delta: { content: 'real answer' }, finish_reason: 'stop' }] }, '[DONE]'])));
  const r = await callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    onText: () => {}, retry: { attempts: 3, baseMs: 1 }
  });
  assert.equal(r.text, 'real answer');
  assert.equal(r.retries, 1);
});

// The audit log said THAT tools were called, never HOW — so after a live run
// the native and text paths were indistinguishable and "did native run?" could
// only be inferred from the model catalogue (V1 task 11).
test('toolProtocol names the path a worker will take', async () => {
  const { toolProtocol } = await import('../core/agent.js');
  assert.equal(toolProtocol({ provider: 'openrouter', supportsTools: true }), 'native');
  assert.equal(toolProtocol({ provider: 'openrouter', supportsTools: false }), 'text');
  assert.equal(toolProtocol({ provider: 'openrouter' }), 'text', 'unknown capability falls back to text');
  assert.equal(toolProtocol({ provider: 'anthropic', supportsTools: true }), 'text', 'native is openrouter-only today');
  assert.equal(toolProtocol({ provider: 'mock' }), 'text');
  assert.equal(toolProtocol(undefined), 'text');
});

// --- streaming a tool-using turn (V1 task 12) -----------------------------

// This path used to refuse to stream whenever tools were present. Once the work
// templates became agentTasks, that meant every coding node was silent and the
// live panel went blank for exactly the nodes doing the work.
test('native tool calls stream, and reassemble into the message the loop echoes', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { content: 'Writing it now.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"src/a.js",' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { total_tokens: 12 } },
    '[DONE]'
  ]));
  const seen = [];
  const r = await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'write_file', description: '', parameters: {} } }],
    apiKey: 'k', onText: t => seen.push(t)
  });

  assert.equal(calls[0].body.stream, true, 'a tool-using turn must stream');
  assert.equal(r.finishReason, 'tool_calls');
  assert.deepEqual(r.usage, { total_tokens: 12 });
  // The id/name arrive once; the arguments fragments concatenate in order.
  assert.deepEqual(r.message.tool_calls, [{
    id: 'call_1', type: 'function',
    function: { name: 'write_file', arguments: '{"path":"src/a.js","content":"x"}' }
  }]);
  assert.equal(JSON.parse(r.message.tool_calls[0].function.arguments).path, 'src/a.js');
  // `text` stays the model's real content, not the rendered view.
  assert.equal(r.text, 'Writing it now.');
  assert.equal(r.message.content, 'Writing it now.');
  // ...but the watcher saw the call assemble, argument by argument.
  assert.ok(seen.length >= 4);
  assert.match(seen.at(-1), /Writing it now\./);
  // A completed call renders as real lines, not an escaped JSON blob: a file's
  // content arrives with its newlines escaped and is unreadable dumped raw.
  assert.ok(seen.at(-1).includes('→ write_file\npath: src/a.js\ncontent: x'));
});

test('a turn that is only tool calls still streams something watchable', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ]));
  const seen = [];
  const r = await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'bash', description: '', parameters: {} } }],
    apiKey: 'k', onText: t => seen.push(t)
  });
  assert.equal(r.text, '', 'no prose in this turn');
  assert.equal(r.message.content, null, 'the API wants null, not empty string, alongside tool_calls');
  assert.ok(seen.at(-1).includes('→ bash\ncommand: npm test'));
  // A tool-only turn is a real answer: it must NOT trip the empty-stream guard.
  assert.equal(r.message.tool_calls.length, 1);
});

test('parallel tool calls in one turn reassemble by index, in order', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { tool_calls: [
      { index: 1, id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"p":2}' } },
      { index: 0, id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"p":' } }
    ] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]'
  ]));
  const r = await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'read_file', description: '', parameters: {} } }],
    apiKey: 'k', onText: () => {}
  });
  assert.deepEqual(r.message.tool_calls.map(c => [c.id, c.function.arguments]),
    [['a', '{"p":1}'], ['b', '{"p":2}']], 'index orders the calls, not arrival');
});

// The end-to-end shape: a streamed tool turn must drive the agent loop exactly
// as the non-streamed one did — same echo, same role:'tool' reply.
test('the agent loop runs a full round trip over a STREAMED tool turn', async () => {
  const store = { appendLog: () => {}, writeTaskSpec: () => 'tasks/task-1.spec.md' };
  stubFetch(({ n }) => (n === 1
    ? sseRes([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'write_task_md', arguments: '{"content":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"# Spec"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
    ])
    : sseRes([{ choices: [{ delta: { content: 'All done.' }, finish_reason: 'stop' }] }, '[DONE]'])));

  const { getTools } = await import('../core/tools/index.js');
  const out = await runAgent({
    worker: { provider: 'openrouter', model: 'tool-model', supportsTools: true },
    apiKey: 'k', system: 'S', prompt: 'P',
    tools: getTools(['write_task_md']),
    ctx: { store, runId: 'r1', taskId: 'task-1' },
    onText: () => {}
  });
  assert.equal(out.text, 'All done.');
  assert.equal(out.toolCalls[0].ok, true, 'the reassembled arguments must parse and execute');
  const second = calls[1].body.messages;
  assert.equal(second.at(-2).tool_calls[0].id, 'c1');
  assert.equal(second.at(-1).tool_call_id, 'c1');
});

// A file's content reaches us as a JSON string, so its newlines arrive escaped.
// Dumped raw that reads as one long \n-littered line — watchable only in the
// most literal sense. Built with JSON.stringify, exactly as a provider builds it.
test('a completed tool call renders readably, with real newlines', async () => {
  const args = JSON.stringify({ path: 'a.js', content: 'line1\nline2' });
  stubFetch(() => sseRes([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write_file', arguments: args } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
  ]));
  const seen = [];
  const r = await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'write_file', description: '', parameters: {} } }],
    apiKey: 'k', onText: t => seen.push(t)
  });
  assert.equal(seen.at(-1), '→ write_file\npath: a.js\ncontent: line1\nline2');
  assert.ok(!seen.at(-1).includes('\\n'), 'no escaped newlines survive into the watched view');
  // The reassembled arguments stay byte-exact — the pretty view is a view only.
  assert.equal(r.message.tool_calls[0].function.arguments, args);
});

// Mid-assembly the JSON cannot parse yet; show it raw rather than nothing.
test('an incomplete tool call still shows raw while it assembles', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
  ]));
  const seen = [];
  await callModel({
    provider: 'openrouter', model: 'm', messages: [{ role: 'user', content: 'p' }],
    tools: [{ type: 'function', function: { name: 'write_file', description: '', parameters: {} } }],
    apiKey: 'k', onText: t => seen.push(t)
  });
  assert.equal(seen[0], '→ write_file({"path":"a.)'); // raw, paren and all
});

// --- reasoning models (D40) -----------------------------------------------
//
// A reasoning model puts most of a turn in `delta.reasoning` and emits its
// `content` last, or — when the token budget runs out first — not at all. The
// adapter used to ignore that field entirely, which cost the app three separate
// things: the progress signal (a node sat visibly frozen for a minute or more
// and got cancelled by hand on healthy runs), the evidence (a turn that ended
// in reasoning alone was reported as "empty response" with nothing on disk to
// say why), and the money already spent on the tokens.
//
// Measured against the real provider: deepseek-v4-pro-0813 at max_tokens 4096 —
// this app's `medium` effort — returned 0 characters of answer, 4096 reasoning
// tokens and finish_reason "length".

test('openrouter: reasoning deltas are captured, and never leak into the answer', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { reasoning: 'let me think' } }] },
    { choices: [{ delta: { reasoning: ' about it' } }] },
    { choices: [{ delta: { content: 'The answer.' }, finish_reason: 'stop' }] },
    '[DONE]'
  ]));
  const seen = [];
  const r = await callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: t => seen.push(t)
  });
  assert.equal(r.text, 'The answer.', 'the deliverable is content only');
  assert.equal(r.reasoning, 'let me think about it');
  // Watchable from the first reasoning delta rather than silent until the end...
  assert.ok(seen[0].includes('let me think'));
  // ...and replaced by the real answer the moment there is one.
  assert.equal(seen.at(-1), 'The answer.');
});

test('openrouter: reasoning arrives on the non-streamed path too', async () => {
  stubFetch(() => jsonRes({
    choices: [{ message: { role: 'assistant', content: 'ok', reasoning: 'thought' }, finish_reason: 'stop' }]
  }));
  const r = await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k' });
  assert.equal(r.text, 'ok');
  assert.equal(r.reasoning, 'thought');
});

// The exact failure four live runs died on: the budget goes entirely to
// reasoning, so the turn ends with finish_reason "length" and no content. It
// must not be mistaken for a cut connection (which is transient and retried
// identically) — it is a real, complete, useless answer, and the caller needs
// the evidence to say so.
test('openrouter: a turn that is all reasoning and no content still reports itself', async () => {
  stubFetch(() => sseRes([
    { choices: [{ delta: { reasoning: 'thinking'.repeat(50) } }] },
    { choices: [{ delta: {}, finish_reason: 'length' }] },
    '[DONE]'
  ]));
  const r = await callModel({ provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k', onText: () => {} });
  assert.equal(r.text, '');
  assert.equal(r.finishReason, 'length');
  assert.equal(r.reasoning.length, 400);
});

// --- the empty-turn recovery (D40) ----------------------------------------

test('an empty turn is retried once, with the budget raised and the omission named', async () => {
  stubFetch(({ n }) => (n === 1
    ? jsonRes({ choices: [{ message: { content: '', reasoning: 'thought hard' }, finish_reason: 'length' }] })
    : jsonRes({ choices: [{ message: { content: 'Here it is.' }, finish_reason: 'stop' }] })));
  const empties = [];
  const r = await runAgent({
    worker: { provider: 'openrouter', model: 'm' }, apiKey: 'k',
    system: 'S', prompt: 'P', maxTokens: 4096,
    onEmptyTurn: d => empties.push(d)
  });
  assert.equal(r.text, 'Here it is.', 'the recovered turn is the answer');
  assert.equal(calls.length, 2);
  assert.ok(calls[1].body.max_tokens > calls[0].body.max_tokens, 'the retry gets a bigger budget');
  assert.match(calls[1].body.messages.at(-1).content, /returned no content/);
  assert.equal(empties.length, 1);
  assert.equal(empties[0].finishReason, 'length');
});

test('a turn that is only tool calls is not treated as empty', async () => {
  stubFetch(({ n }) => (n === 1
    ? jsonRes({
      choices: [{
        message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'now', arguments: '{}' } }] },
        finish_reason: 'tool_calls'
      }]
    })
    : jsonRes({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }] })));
  const r = await runAgent({
    worker: { provider: 'openrouter', model: 'm', supportsTools: true }, apiKey: 'k',
    system: 'S', prompt: 'P',
    tools: [{ name: 'now', description: 'time', parameters: { type: 'object', properties: {} } }],
    ctx: {}
  });
  assert.equal(r.text, 'done');
  // Two calls: the tool turn and the answer. A third would mean the tool-only
  // turn had been misread as empty and nudged.
  assert.equal(calls.length, 2);
});

// --- the black box (D40) --------------------------------------------------

test('onCall records what was sent and what came back, for every settled call', async () => {
  stubFetch(() => jsonRes({
    choices: [{ message: { content: 'hi', reasoning: 'mm' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 9, completion_tokens: 2 }
  }));
  const records = [];
  await callModel({
    provider: 'openrouter', model: 'm', system: 'SYS', prompt: 'PROMPT',
    maxTokens: 777, apiKey: 'k', onCall: r => records.push(r)
  });
  assert.equal(records.length, 1);
  const rec = records[0];
  assert.equal(rec.ok, true);
  assert.equal(rec.model, 'm');
  assert.equal(rec.maxTokens, 777);
  assert.equal(rec.finishReason, 'stop');
  assert.equal(rec.contentChars, 2);
  assert.equal(rec.reasoningChars, 2);
  assert.equal(rec.promptChars, 'SYS'.length + 'PROMPT'.length);
  assert.deepEqual(rec.usage, { prompt_tokens: 9, completion_tokens: 2 });
});

test('onCall records a failure too, once, after the retry budget is spent', async () => {
  stubFetch(() => errRes(429, 'slow down'));
  const records = [];
  await assert.rejects(() => callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    retry: { attempts: 2, baseMs: 1 }, onCall: r => records.push(r)
  }));
  assert.equal(records.length, 1, 'one record per settled call, not per attempt');
  assert.equal(records[0].ok, false);
  assert.match(records[0].error, /429/);
  assert.equal(records[0].attempts, 2);
});

test('a throwing onCall never takes the call down with it', async () => {
  stubFetch(() => jsonRes({ choices: [{ message: { content: 'fine' } }] }));
  const r = await callModel({
    provider: 'openrouter', model: 'm', prompt: 'p', apiKey: 'k',
    onCall: () => { throw new Error('instrumentation blew up'); }
  });
  assert.equal(r.text, 'fine');
});
