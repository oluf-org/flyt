// Where the money went, and the node that was billed for twice.
//
// Both halves of this file come from one reading. `flyt spend` reported a
// total and nothing else, so the first thing built here was the breakdown —
// and the first breakdown printed showed `executor_task-1` at 40 calls beside
// `executor-task-1` at 1 call, for the same $0.1470. One node, two spellings,
// counted twice, in every total the app has ever shown.
//
// A ledger that reads HIGH is worse than one that reads low: a cap trips
// early, and a task is parked for money it never spent. That is exactly what
// the loop log showed — a task parked at $0.77 against a $0.5 cap "over 0
// attempt(s)".
import test from 'node:test';
import assert from 'node:assert/strict';
import { breakdown, liveEntries, spendFromRun } from '../core/ledger.js';
import { makeStore } from './helpers.js';

const call = (usd, over = {}) => ({
  ok: true, provider: 'openrouter', model: 'a/model',
  usage: { prompt_tokens: 10, completion_tokens: 5, cost: usd }, ...over
});

test('a node whose trace and retrospective spell it differently is billed once', () => {
  const store = makeStore();
  const runId = store.createRun('a run with an agent task in it');
  // The trace is a FILE, so its name is sanitised on the way to disk; the
  // retrospective is a JSON key, so it is not. Same node, two spellings.
  store.writeCallTrace(runId, 'executor:task-1', call(0.05));
  store.writeCallTrace(runId, 'executor:task-1', call(0.09));
  store.writeRetrospective(runId, 'executor_task-1', {
    status: 'done', model: { provider: 'openrouter', model: 'a/model' },
    usage: { prompt_tokens: 900, completion_tokens: 400, cost: 0.14 }
  });

  const entries = spendFromRun(store, runId);
  const usd = entries.reduce((t, e) => t + (e.usd ?? 0), 0);
  assert.equal(entries.length, 2, 'the two traced calls, and not the summary of them again');
  assert.equal(Number(usd.toFixed(4)), 0.14);
});

test('a node with a retrospective and no trace is still billed', () => {
  const store = makeStore();
  const runId = store.createRun('a run whose node wrote no trace');
  store.writeRetrospective(runId, 'plan', {
    status: 'done', model: { provider: 'openrouter', model: 'a/model' },
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.02 }
  });
  const entries = spendFromRun(store, runId);
  assert.equal(entries.length, 1, 'the fallback still fires — this is a dedupe, not a filter');
  assert.equal(entries[0].usd, 0.02);
});

test('spend groups along a dimension, biggest first', () => {
  const rows = breakdown([
    { taskId: 't-1', model: 'cheap', usd: 0.01, at: '2026-08-21T00:00:00Z' },
    { taskId: 't-2', model: 'dear', usd: 0.40, at: '2026-08-21T00:00:00Z' },
    { taskId: 't-1', model: 'cheap', usd: 0.02, at: '2026-08-21T00:00:00Z' }
  ], { by: 'task' });
  assert.deepEqual(rows.map(r => r.key), ['t-2', 't-1']);
  assert.equal(rows[1].calls, 2);
  assert.equal(Number(rows[1].usd.toFixed(2)), 0.03);
  assert.deepEqual(rows[1].models, ['cheap']);
});

test('an unpriced call is carried as unknown, never as zero', () => {
  const rows = breakdown([
    { taskId: 't-1', usd: null, at: '2026-08-21T00:00:00Z' },
    { taskId: 't-1', usd: 0.10, estimated: true, at: '2026-08-21T00:00:00Z' }
  ], { by: 'task' });
  assert.equal(rows[0].unknown, 1);
  assert.equal(rows[0].estimated, 1);
  assert.equal(rows[0].calls, 2, 'a call nobody priced is still a call that happened');
});

test('a long tail collapses into one row that says how many it stands for', () => {
  const entries = Array.from({ length: 9 }, (_, i) => ({ taskId: `t-${i}`, usd: (9 - i) / 100 }));
  const rows = breakdown(entries, { by: 'task', limit: 3 });
  assert.equal(rows.length, 4);
  assert.equal(rows[3].key, '(other)');
  assert.equal(rows[3].groups, 6);
  assert.equal(rows[3].calls, 6);
});

test('refusing an unknown dimension names the ones there are', () => {
  assert.throws(() => breakdown([], { by: 'colour' }), /task, model, run, node, level, day/);
});

test('in-flight calls arrive shaped like ledger lines, carrying their task', () => {
  const store = makeStore();
  const runId = store.createRun('a run still going');
  store.writeCallTrace(runId, 'plan', call(0.03));
  const live = liveEntries(store, [{ runId, taskId: 't-9', level: 'high' }]);
  assert.equal(live.length, 1);
  assert.equal(live[0].taskId, 't-9');
  assert.equal(live[0].level, 'high');
  assert.equal(live[0].live, true, 'a running meter must be distinguishable from a receipt');
  assert.equal(breakdown(live, { by: 'task' })[0].live, 0.03);
});
