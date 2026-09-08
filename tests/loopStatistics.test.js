import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateLoops, chatHistory, loopSummary, selectLoops } from '../core/loopStatistics.js';
import { elapsed } from '../src/activityFormat.js';

const goal = overrides => ({ id: 'g1', projectId: 'p1', name: 'Improve report', status: 'achieved',
  createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z',
  iteration: 2, calls: 4, knownUsd: .004, unknownCostCalls: 1, elapsedMs: 90000,
  contract: { criteria: [{}, {}], tests: [{}], limits: { iterations: 5 }, worker: { model: 'model-a' } },
  best: { score: 1, preview: 'Accepted result' }, history: [{ iteration: 1, score: .5 }, { iteration: 2, score: 1 }], ...overrides });

test('loop summary preserves unknown usage and counts fixed checks plus candidate tests', () => {
  const row = loopSummary(goal());
  assert.equal(row.tokens, null);
  assert.equal(row.passedChecks, 3);
  assert.equal(row.unknownCostCalls, 1);
  assert.equal(row.iterations, 2);
  assert.equal(row.kind, 'loop');
});

test('historical totals count instances once and do not count paused work as unsuccessful', () => {
  const a = loopSummary(goal()), newer = { ...a, updatedAt: '2026-09-03T10:00:00Z', calls: 5 };
  const b = loopSummary(goal({ id: 'g2', status: 'paused' }));
  const rows = selectLoops([a, newer, b]);
  assert.equal(rows.length, 2);
  assert.equal(aggregateLoops(rows).calls, 9);
  assert.equal(aggregateLoops(rows).successRate, 1);
  assert.equal(selectLoops(rows, { model: 'absent' }).length, 0);
  assert.equal(selectLoops(rows, { projectId: 'other' }).length, 0);
  assert.equal(selectLoops(rows, { from: '2026-09-03T00:00:00Z' }).length, 1);
  assert.equal(selectLoops(rows, { to: '2026-08-31T00:00:00Z' }).length, 0);
});

test('history groups follow-ups and loop children while retaining orphaned historical workflows', () => {
  const loops = [loopSummary(goal())];
  const runs = [
    { id: 'first', conversationId: 'conversation', name: 'Original request', createdAt: '2026-09-01' },
    { id: 'second', conversationId: 'conversation', parentRunId: 'first', name: 'Follow-up', createdAt: '2026-09-02', stage: 'done' },
    { id: 'goal-g1-iteration-1', createdAt: '2026-09-02' },
    { id: 'goal-g1-iteration-1--child-task', createdAt: '2026-09-02' },
    { id: 'orphan', goalId: 'removed-goal', createdAt: '2026-09-03' },
  ];
  const rows = chatHistory(runs, loops);
  assert.equal(rows.length, 3);
  const conversation = rows.find(row => row.id === 'second');
  assert.equal(conversation.name, 'Original request');
  assert.equal(conversation.conversationRuns, 2);
  assert.equal(rows.filter(row => row.kind === 'loop').length, 1);
  assert.equal(runs.length, 5);
});

test('duration labels round cleanly across minutes and hours', () => {
  assert.equal(elapsed(null), '—'); assert.equal(elapsed(0), '0s');
  assert.equal(elapsed(59999), '1m 0s'); assert.equal(elapsed(3600000), '1h 0m');
});
