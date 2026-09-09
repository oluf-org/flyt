import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { measure, distribution, checkPerformance } from '../scripts/performance-metrics.mjs';
import { summarizeCpu, interactionMetrics } from '../scripts/performance-profiles.mjs';

test('percentiles use nearest ranks without mutating input', () => {
  const values = [5, 1, 3, 4, 2];
  assert.deepEqual(distribution(values), { count: 5, min: 1, p50: 3, p95: 5, p99: 5, max: 5 });
  assert.deepEqual(values, [5, 1, 3, 4, 2]);
  assert.equal(distribution([]).p95, null);
});
test('work budgets detect rereads regardless of timing; cold work is reported separately', () => {
  const report = { fixtures: [{ count: 100, samples: [
    { phase: 'cold', name: 'run:list', syncReadBytes: 1000, summaryReadCalls: 20, durationMs: 500 },
    { phase: 'warm', name: 'run:list', syncReadBytes: 1, summaryReadCalls: 0, durationMs: 1 },
    { phase: 'warm', name: 'history:activity', syncReadBytes: 0, summaryReadCalls: 1, durationMs: 51 },
  ] }] };
  assert.equal(checkPerformance(report, { checkReads: true }).length, 2);
  assert.equal(checkPerformance(report, { historyMs: 50 }).length, 1);
});
test('failed measurements restore filesystem hooks and release instrumentation', async () => {
  const read = fs.readSync, file = fs.readFileSync;
  await assert.rejects(measure('failure', () => { throw new Error('expected'); }), /expected/);
  assert.equal(fs.readSync, read); assert.equal(fs.readFileSync, file);
  assert.equal((await measure('recovered', () => [1])).sample.rows, 1);
});

test('warm read budgets include work moved into the background worker', () => {
  const report = { fixtures: [{ count: 1, samples: [
    { phase: 'warm', name: 'run:list', workerReadBytes: 1 },
    { phase: 'warm', name: 'history:activity', workerSummaryReadCalls: 1 },
  ] }] };
  assert.equal(checkPerformance(report, { checkReads: true }).length, 2);
});

test('CPU attribution clips phase boundaries and counts recursive functions once inclusively', () => {
  const callFrame = { functionName: 'recursive', url: 'app.js', lineNumber: 0, columnNumber: 0 };
  const result = summarizeCpu({ epochStartMs: 100, profile: {
    nodes: [{ id: 1, callFrame, children: [2] }, { id: 2, callFrame }],
    samples: [2, 2], timeDeltas: [10000, 10000],
  } }, 105, 10);
  assert.equal(result[0].selfMs, 10);
  assert.equal(result[0].totalMs, 10);
});

test('interaction tails use the longest event per interaction and exclude other phases', () => {
  const row = (interactionId, durationMs, at = 10) => ({ type: 'event', interactionId, durationMs, at });
  assert.deepEqual(interactionMetrics([row(1, 16), row(1, 32), row(2, 24), row(0, 100), row(3, 80, 20)], { at: 10, durationMs: 10 }), [row(1, 32), row(2, 24)]);
});
