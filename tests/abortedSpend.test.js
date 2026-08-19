// The spend a killed call still costs.
//
// Found by running the loop, not by reading the code. A planning node streamed
// 560,242 lines of degenerate output, the liveness watchdog killed it at 77
// seconds, and the call record came back `ok: false` with no usage, no cost and
// no ledger line. The provider had generated — and billed — every one of those
// tokens. The project ledger reported $2.25 for the session; the key was $4
// over its $35 limit by the end of it.
//
// That is not an accounting nicety: the spend ceilings are checked against this
// ledger between tasks, so the one failure mode most able to burn a night's
// budget in one call was the one the caps could not see.
import test from 'node:test';
import assert from 'node:assert/strict';
import { callRecord, CHARS_PER_TOKEN } from '../core/adapters/index.js';
import { costOf, spendFromRun, pricesFromCatalog } from '../core/ledger.js';
import { makeStore } from './helpers.js';

const ctx = (over = {}) => ({
  provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813',
  system: 'sys', prompt: 'p', maxTokens: 12288, started: Date.now() - 77_000, ...over
});

test('a call killed mid-stream records what it generated, marked as an estimate', () => {
  const rec = callRecord(ctx({ streamedChars: 400_000 }), null, new Error('This operation was aborted'));
  assert.equal(rec.ok, false);
  assert.equal(rec.streamedChars, 400_000);
  assert.equal(rec.estimated, true);
  assert.equal(rec.usage.completion_tokens, 400_000 / CHARS_PER_TOKEN);
  assert.equal(rec.usage.estimated, true, 'nothing downstream may mistake this for a measurement');
});

test('a call that failed before generating anything invents no spend', () => {
  const rec = callRecord(ctx({ streamedChars: 0 }), null, new Error('401 unauthorized'));
  assert.equal(rec.ok, false);
  assert.equal(rec.usage, undefined, 'a failure with nothing generated cost nothing to generate');
  assert.equal(rec.streamedChars, undefined);
});

test('a successful call is untouched by any of this', () => {
  const rec = callRecord(ctx({ streamedChars: 120 }), { text: 'hi', finishReason: 'stop', usage: { cost: 0.01 } }, null);
  assert.equal(rec.ok, true);
  assert.equal(rec.usage.cost, 0.01);
  assert.equal(rec.estimated, undefined, 'the provider reported; there is nothing to estimate');
});

test('the aborted call reaches the ledger, priced from the catalog', () => {
  const store = makeStore();
  const runId = store.createRun('a run whose planner ran away');
  store.writeCallTrace(runId, 'plan', callRecord(
    ctx({ streamedChars: 4_000_000 }), null, new Error('This operation was aborted')));

  const prices = pricesFromCatalog({
    'deepseek/deepseek-v4-pro-0813': { inUsdPerM: 0.66, outUsdPerM: 1.98 }
  });
  const entries = spendFromRun(store, runId, { prices });
  const aborted = entries.filter(e => e.aborted);
  assert.equal(aborted.length, 1, 'the killed call is a ledger line now, not silence');
  assert.equal(aborted[0].node, 'plan');
  assert.equal(aborted[0].estimated, true);
  // 4M chars ≈ 1M output tokens ≈ $1.98, plus a negligible prompt.
  assert.ok(aborted[0].usd > 1.9 && aborted[0].usd < 2.1, `expected ≈$1.98, got ${aborted[0].usd}`);
  assert.match(aborted[0].error, /aborted/);
});

test('a failed call with no usage stays out of the ledger', () => {
  const store = makeStore();
  const runId = store.createRun('a run that could not authenticate');
  store.writeCallTrace(runId, 'plan', callRecord(ctx({ streamedChars: 0 }), null, new Error('401')));
  assert.deepEqual(spendFromRun(store, runId, { prices: {} }).filter(e => e.aborted), []);
});

test('the catalog is the price table, and a hand-written price still wins', () => {
  const prices = pricesFromCatalog(
    {
      'a/model': { inUsdPerM: 1, outUsdPerM: 2 },
      'b/model': { name: 'no price here' }
    },
    { 'a/model': { in: 99, out: 99 } }
  );
  assert.deepEqual(prices['a/model'], { in: 99, out: 99 }, 'an operator who wrote an override meant it');
  assert.equal(prices['b/model'], undefined, 'an unpriced catalog entry stays unpriced');
});

test('costOf still prefers what the provider actually charged', () => {
  const reported = costOf({
    usage: { cost: 0.5, completion_tokens: 1_000_000 },
    provider: 'openrouter', model: 'a/model',
    prices: { 'a/model': { in: 1, out: 2 } }
  });
  assert.deepEqual(reported, { usd: 0.5, estimated: false });
});

// --- the calls a run made, whatever became of the run ------------------------
//
// Reconciled against a real session: nine runs, of which four reached the
// ledger with nothing at all — one that failed, two that were stopped, one the
// loop owned. The project ledger said $2.25; the key had moved $24.58. Reading
// the call traces accounts for all of it.

test('a node that FAILED still spent, and the trace is where that is written', () => {
  const store = makeStore();
  const runId = store.createRun('a run whose node failed after doing real work');
  // Three successful billed rounds, then the node fails. No retrospective is
  // written for a failed node, so the summary shows nothing.
  for (let i = 0; i < 3; i++) {
    store.writeCallTrace(runId, 'work', callRecord(ctx(), {
      text: 'round', finishReason: 'tool_calls', usage: { cost: 0.5 }
    }, null));
  }
  const entries = spendFromRun(store, runId, { prices: {} });
  assert.equal(entries.length, 3);
  assert.equal(entries.reduce((n, e) => n + e.usd, 0), 1.5,
    'three billed rounds are three billed rounds whether the node finished or not');
});

test('the trace and the retrospective never double-count one node', () => {
  const store = makeStore();
  const runId = store.createRun('a node that finished tidily');
  store.writeCallTrace(runId, 'plan', callRecord(ctx(), {
    text: 'the plan', finishReason: 'stop', usage: { cost: 2 }
  }, null));
  store.writeRetrospective(runId, 'plan', {
    model: { provider: 'openrouter', model: 'deepseek/deepseek-v4-pro-0813' },
    usage: { cost: 2 }
  });
  const entries = spendFromRun(store, runId, { prices: {} });
  assert.equal(entries.length, 1, 'the trace wins; the summary is the fallback');
  assert.equal(entries[0].usd, 2);
});

test('a node with no trace still reports through its retrospective', () => {
  const store = makeStore();
  const runId = store.createRun('an executor task with no call file');
  store.writeRetrospective(runId, 'executor-task-1', {
    model: { provider: 'openrouter', model: 'a/model' },
    usage: { cost: 0.25 }
  });
  const entries = spendFromRun(store, runId, { prices: {} });
  assert.deepEqual(entries.map(e => [e.node, e.usd]), [['executor-task-1', 0.25]]);
});
