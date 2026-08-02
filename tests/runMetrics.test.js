// PIVOT-PLAN P3 — the ledger, folded into what a run surface shows.
//
// The fold is the only place a number can be invented, so this file is where
// "the numbers have files behind them" is kept honest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runMetrics, percentiles, callsForNode, formatMs, formatTokens, hasMetrics } from '../core/runMetrics.js';

const call = (o = {}) => ({
  seq: 1, nodeId: 'a', taskId: null, ok: true, attempt: 0,
  durationMs: 1000, ttftMs: 200, outputTokensPerSec: 30,
  provider: 'anthropic', model: 'claude-sonnet-5',
  usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 50, reasoningTokens: 0, totalTokens: 150 },
  cost: { total: 0.01, currency: 'USD', estimated: false, costKind: 'tokens' },
  error: null, ...o
});

test('metrics fold per node and per task without double-counting the run', () => {
  const m = runMetrics([
    call({ seq: 1, nodeId: 'a' }),
    call({ seq: 2, nodeId: 'b' }),
    call({ seq: 3, nodeId: 'b', taskId: 'task-1' })
  ], { recordVersion: 2 });
  assert.equal(m.run.calls, 3);
  assert.equal(m.nodes.a.calls, 1);
  assert.equal(m.nodes.b.calls, 2);
  assert.equal(m.tasks['task-1'].calls, 1);
  assert.equal(m.run.cost.total, 0.03);
  assert.equal(m.run.usage.totalTokens, 450);
});

test('a failed attempt that never got a response adds no cost and no doubt', () => {
  // A 429 refused the request; it did not bill for it. Counting its null cost
  // as "unpriced" would mark the run estimated on the strength of a call that
  // provably cost nothing — and a ~ on every run means nothing.
  const m = runMetrics([
    call({ seq: 1 }),
    call({ seq: 2, ok: false, error: 'API 429', usage: null, cost: { total: null, estimated: true, costKind: 'tokens' }, attempt: 0 }),
    call({ seq: 3, attempt: 1 })
  ], { recordVersion: 2 });
  assert.equal(m.run.cost.total, 0.02);
  assert.equal(m.run.cost.estimated, false);
  assert.equal(m.run.errors, 1);
  assert.equal(m.run.retries, 1);
  // The node recovered — it should not read as a red node.
  assert.equal(m.nodes.a.recovered, true);
  assert.equal(m.nodes.a.lastError, 'API 429');
});

test('a run with no ledger is labelled pre-metrics, not zeroed', () => {
  const old = runMetrics([], { recordVersion: 1 });
  assert.equal(old.preMetrics, true);
  assert.equal(old.run.calls, 0);
  assert.equal(old.run.cost.total, null);   // null, never 0
  // A v2 run that simply hasn't made a call yet is NOT pre-metrics.
  assert.equal(runMetrics([], { recordVersion: 2 }).preMetrics, false);
  assert.equal(hasMetrics({ recordVersion: 2 }), true);
  assert.equal(hasMetrics({}), false);
});

test('percentiles are nearest-rank, and an outlier survives into p95/max', () => {
  const p = percentiles([100, 100, 100, 100, 100, 100, 100, 100, 100, 347_000]);
  assert.equal(p.n, 10);
  assert.equal(p.p50, 100);
  assert.equal(p.max, 347_000);
  // The point of §6.2.3: the hang is visible. An average would read as 34,790ms
  // and describe no call that actually happened.
  assert.equal(p.p95, 347_000);
  assert.equal(percentiles([]), null);
  assert.equal(percentiles([null, undefined]), null);
});

test('percentiles ignore the null ttft a non-streaming call reports', () => {
  const m = runMetrics([
    call({ seq: 1, ttftMs: null }),
    call({ seq: 2, ttftMs: 500 })
  ], { recordVersion: 2 });
  assert.equal(m.run.ttft.n, 1);
  assert.equal(m.run.ttft.p50, 500);
});

test('callsForNode matches on node id or task id and drops the raw usage blob', () => {
  const calls = [
    call({ seq: 1, nodeId: 'a', rawUsage: { input_tokens: 1 } }),
    call({ seq: 2, nodeId: 'b', taskId: 'task-1', rawUsage: { input_tokens: 1 } })
  ];
  assert.deepEqual(callsForNode(calls, 'a').map(c => c.seq), [1]);
  assert.deepEqual(callsForNode(calls, null, 'task-1').map(c => c.seq), [2]);
  assert.equal('rawUsage' in callsForNode(calls, 'a')[0], false);
});

test('formatters read at a glance and never print a misleading zero', () => {
  assert.equal(formatMs(null), '—');
  assert.equal(formatMs(640), '640ms');
  assert.equal(formatMs(8412), '8.4s');
  assert.equal(formatMs(134_000), '2m 14s');
  assert.equal(formatTokens(null), '—');
  assert.equal(formatTokens(243), '243');
  assert.equal(formatTokens(12_400), '12k');
  assert.equal(formatTokens(1_240_000), '1.2M');
});
