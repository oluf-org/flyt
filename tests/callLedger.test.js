// PIVOT-PLAN P1 — the call ledger.
//
// Four things this file exists to keep true (§7, Milestone A):
//   - one record per ATTEMPT, so retries are never invisible
//   - durationMs times the attempt, not the backoff sleeps in front of it
//   - no secret ever reaches disk (verification item 2)
//   - a truncated wire record says it was truncated
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore } from './helpers.js';
import { callModel, registerProvider } from '../core/adapters/index.js';
import { makeCallLedger, boundJson, rollupCalls, WIRE_LIMIT_BYTES } from '../core/callLedger.js';
import { redactWire, redactText, REDACTED } from '../core/tools/redact.js';

const run = store => store.createRun('ledger test');

// --- record shape --------------------------------------------------------------

test('a successful call writes one record carrying usage, cost and timing', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-ok', async () => ({
    text: 'hi', usage: { input_tokens: 1_000_000, output_tokens: 0 }, finishReason: 'stop'
  }));
  await callModel({
    provider: 'ledger-ok', model: 'claude-sonnet-5', prompt: 'p',
    ledger: makeCallLedger(store, runId, { nodeId: 'implement', role: 'aiStep' })
  });
  const calls = store.readCalls(runId);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.seq, 1);
  assert.equal(c.nodeId, 'implement');
  assert.equal(c.role, 'aiStep');
  assert.equal(c.attempt, 0);
  assert.equal(c.ok, true);
  assert.equal(c.finishReason, 'stop');
  assert.equal(c.usage.inputTokens, 1_000_000);
  assert.equal(c.cost.total, 3);          // $3/Mtok input, no output
  assert.equal(typeof c.durationMs, 'number');
  // Non-streaming: null, never 0, never faked (§4.2).
  assert.equal(c.ttftMs, null);
});

test('a streaming call records time-to-first-token and throughput', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-stream', async ({ onText }) => {
    await new Promise(r => setTimeout(r, 30));
    onText('par');
    await new Promise(r => setTimeout(r, 30));
    onText('partial', { final: true });
    return { text: 'partial', usage: { input_tokens: 10, output_tokens: 800 } };
  });
  await callModel({
    provider: 'ledger-stream', model: 'claude-sonnet-5', prompt: 'p', onText: () => {},
    ledger: makeCallLedger(store, runId)
  });
  const c = store.readCalls(runId)[0];
  assert.ok(c.ttftMs >= 20, `ttft should reflect the first emit, got ${c.ttftMs}`);
  assert.ok(c.ttftMs < c.durationMs);
  assert.ok(c.outputTokensPerSec > 0);
});

// --- attempts ------------------------------------------------------------------

test('a call that retried twice leaves three records, one per attempt', async () => {
  const store = makeStore();
  const runId = run(store);
  let n = 0;
  registerProvider('ledger-flaky', async () => {
    n += 1;
    if (n < 3) throw new Error('openrouter API 429: slow down');
    return { text: 'ok', usage: { input_tokens: 5, output_tokens: 5 } };
  });
  await callModel({
    provider: 'ledger-flaky', model: 'claude-sonnet-5', prompt: 'p',
    retry: { attempts: 5, baseMs: 1 },
    ledger: makeCallLedger(store, runId, { nodeId: 'flaky' })
  });
  const calls = store.readCalls(runId);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.attempt), [0, 1, 2]);
  assert.deepEqual(calls.map(c => c.ok), [false, false, true]);
  assert.match(calls[0].error, /429/);
  // The failed attempts have no usage to report, and report none rather than 0.
  assert.equal(calls[0].usage, null);
  const roll = rollupCalls(calls);
  assert.equal(roll.calls, 3);
  assert.equal(roll.retries, 2);
  assert.equal(roll.errors, 2);
});

test('durationMs times the attempt, not the backoff in front of it (§4.1.2)', async () => {
  const store = makeStore();
  const runId = run(store);
  let n = 0;
  registerProvider('ledger-slowbackoff', async () => {
    n += 1;
    if (n === 1) throw new Error('openrouter API 503: down');
    return { text: 'ok', usage: null };
  });
  await callModel({
    provider: 'ledger-slowbackoff', model: 'm', prompt: 'p',
    retry: { attempts: 3, baseMs: 150 },
    ledger: makeCallLedger(store, runId)
  });
  const calls = store.readCalls(runId);
  assert.equal(calls.length, 2);
  // The winning attempt started AFTER the sleep and must not have absorbed it.
  assert.ok(calls[1].durationMs < 100,
    `attempt 2 reported ${calls[1].durationMs}ms — it absorbed the 150ms backoff`);
});

// --- wire capture, redaction and bounds ------------------------------------------

test('the wire record is written, pointed at, and redacted', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-wire', async ({ captureWire }) => ({
    text: 'ok',
    usage: { input_tokens: 1, output_tokens: 1 },
    ...(captureWire
      ? {
        wire: {
          request: {
            url: 'https://api.example.com/v1/messages',
            headers: { 'x-api-key': 'sk-ant-abcdefghijklmnopqrstuvwxyz012345', 'content-type': 'application/json' },
            body: { messages: [{ role: 'user', content: 'here is my key sk-abcdefghijklmnopqrstuvwx please use it' }] }
          },
          response: { kind: 'body', body: { ok: true } }
        }
      }
      : {})
  }));
  await callModel({
    provider: 'ledger-wire', model: 'm', prompt: 'p',
    ledger: makeCallLedger(store, runId, { nodeId: 'n1' })
  });
  const c = store.readCalls(runId)[0];
  assert.equal(c.wire.request, 'calls/1.request.json');
  assert.equal(c.wire.response, 'calls/1.response.json');
  assert.equal(c.wire.truncated, false);

  const req = store.readCallWire(runId, 1, 'request');
  // The header key is masked by name; the key pasted INTO the prompt is masked
  // by shape. Neither may survive to disk (verification item 2).
  assert.ok(!req.includes('sk-ant-abcdefghijklmnopqrstuvwxyz012345'));
  assert.ok(!req.includes('sk-abcdefghijklmnopqrstuvwx'));
  assert.ok(req.includes(REDACTED));
  // Everything that isn't a credential survives intact.
  assert.ok(req.includes('here is my key'));
  assert.ok(req.includes('api.example.com'));
});

test('a wire body over the cap is truncated, and the record says so', async () => {
  const store = makeStore();
  const runId = run(store);
  const huge = 'x'.repeat(400 * 1024);
  registerProvider('ledger-huge', async ({ captureWire }) => ({
    text: 'ok', usage: null,
    ...(captureWire ? { wire: { request: { body: { prompt: huge } }, response: { body: 'ok' } } } : {})
  }));
  await callModel({
    provider: 'ledger-huge', model: 'm', prompt: 'p',
    ledger: makeCallLedger(store, runId)
  });
  const c = store.readCalls(runId)[0];
  assert.equal(c.wire.truncated, true);
  const req = store.readCallWire(runId, 1, 'request');
  assert.ok(Buffer.byteLength(req, 'utf8') <= WIRE_LIMIT_BYTES + 1024);
  assert.match(req, /bytes elided/);
});

test('wire capture off writes no wire files and says why', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-off', async ({ captureWire }) => {
    // The adapter must not be asked to build a wire it will never use.
    assert.equal(captureWire, false);
    return { text: 'ok', usage: null };
  });
  await callModel({
    provider: 'ledger-off', model: 'm', prompt: 'p',
    ledger: makeCallLedger(store, runId, { wire: 'off' })
  });
  const c = store.readCalls(runId)[0];
  assert.equal(c.wire, null);
  assert.equal(c.wireUnavailable, 'capture-off');
  assert.equal(fs.existsSync(path.join(store.callsDir(runId), '1.request.json')), false);
});

test('a CLI-delegate call produces a degraded record, not an empty one', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-cli', async () => ({
    text: 'from the CLI', usage: { input_tokens: 20, output_tokens: 30 },
    wire: null, wireUnavailable: 'cli-delegate'
  }));
  await callModel({
    provider: 'ledger-cli', model: 'claude-sonnet-5', prompt: 'p',
    ledger: makeCallLedger(store, runId)
  });
  const c = store.readCalls(runId)[0];
  assert.equal(c.wire, null);
  assert.equal(c.wireUnavailable, 'cli-delegate');
  // Usage, timing and cost are all still there — that is what "degraded" means.
  assert.equal(c.usage.outputTokens, 30);
  assert.ok(c.cost.total > 0);
});

test('a failed call still records the response body the provider sent', async () => {
  const store = makeStore();
  const runId = run(store);
  registerProvider('ledger-err', async ({ captureWire }) => {
    const err = new Error('openrouter API 400: bad request');
    if (captureWire) err.wire = { request: { body: { model: 'm' } }, response: { status: 400, body: { error: 'nope' } } };
    throw err;
  });
  await assert.rejects(() => callModel({
    provider: 'ledger-err', model: 'm', prompt: 'p', retry: { attempts: 1 },
    ledger: makeCallLedger(store, runId)
  }));
  const c = store.readCalls(runId)[0];
  assert.equal(c.ok, false);
  assert.match(store.readCallWire(runId, 1, 'response'), /nope/);
});

// --- the instrument must not break what it measures --------------------------------

test('a ledger that cannot write never fails the call', async () => {
  const runId = 'nonexistent-run';
  const brokenStore = {
    callsDir: () => '/definitely/not/a/real/path',
    writeCallRecord() { throw new Error('disk is on fire'); }
  };
  registerProvider('ledger-safe', async () => ({ text: 'ok', usage: null }));
  const r = await callModel({
    provider: 'ledger-safe', model: 'm', prompt: 'p',
    ledger: makeCallLedger(brokenStore, runId)
  });
  assert.equal(r.text, 'ok');
});

// --- pure helpers -------------------------------------------------------------------

test('boundJson preserves head and tail around the elision', () => {
  const value = { head: 'A'.repeat(50), mid: 'B'.repeat(5000), tail: 'C'.repeat(50) };
  const { text, truncated } = boundJson(value, 2000);
  assert.equal(truncated, true);
  assert.ok(text.startsWith('{\n  "head"'));
  assert.ok(text.trimEnd().endsWith('}'));
  assert.ok(Buffer.byteLength(text, 'utf8') <= 2048);
  assert.equal(boundJson({ a: 1 }, 2000).truncated, false);
});

test('redactText masks credential shapes embedded in prose', () => {
  const s = redactText('run it with sk-ant-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz01');
  assert.ok(!s.includes('sk-ant-'));
  assert.ok(!s.includes('ghp_'));
  assert.equal(s.split(REDACTED).length - 1, 2);
});

test('redactWire masks credential-named headers whatever the value looks like', () => {
  const out = redactWire({ headers: { Authorization: 'Bearer plaintoken', 'X-Api-Key': 'abc', 'content-type': 'application/json' } });
  assert.equal(out.headers.Authorization, REDACTED);
  assert.equal(out.headers['X-Api-Key'], REDACTED);
  assert.equal(out.headers['content-type'], 'application/json');
});

// npm run scan:secrets walks every run artifact with this rule. A rule that
// fires on ordinary node ids is a rule that gets switched off, so the token
// boundaries around the credential shapes matter as much as the shapes.
test('redactText leaves hyphenated ids and ordinary prose alone', () => {
  for (const s of [
    'e-task-a-aiStep-mribsag70',
    'flows/default-pipeline.flow.yaml',
    'the risk-assessment-and-review-step finished',
    'aiStep-mkq1x8lz-a7bd'
  ]) {
    assert.equal(redactText(s), s, `redactText mangled "${s}"`);
  }
});

// --- end to end through the runner ---------------------------------------------

test('a flow run ledgers every node call, attributed to its node', async () => {
  const { FlowRunner } = await import('../core/flowRunner.js');
  const { setScript, testConfig, waitForStage, makeFlow, node, edge } = await import('./helpers.js');
  const store = makeStore();
  setScript(() => ({ text: 'answer', usage: { input_tokens: 1000, output_tokens: 100 } }));
  const runner = new FlowRunner(store, testConfig({
    workers: { executor: { provider: 'script', model: 'claude-sonnet-5' } }
  }));
  const flow = makeFlow(
    [node('in', 'input', { text: 'do the thing' }), node('a', 'aiStep'), node('b', 'aiStep'), node('out', 'output')],
    [edge('in', 'a'), edge('a', 'b'), edge('b', 'out')]);
  const runId = runner.start(flow);
  await waitForStage(store, runId, ['done', 'failed']);

  const calls = store.readCalls(runId);
  assert.deepEqual(calls.map(c => c.nodeId), ['a', 'b']);
  assert.ok(calls.every(c => c.role === 'aiStep'));
  assert.ok(calls.every(c => c.cost.total > 0), 'a known model must produce a real cost');
  // v2 record format: the investigator can tell this run measured itself.
  assert.equal(store.readMeta(runId).recordVersion, 2);
});
