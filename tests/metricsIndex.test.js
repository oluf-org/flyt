// PIVOT-PLAN P4 — the derived index and the Investigator's queries.
//
// The contract this file guards is §4.5's: the index is DERIVED AND DISPOSABLE.
// Verification item 7 — delete runs/_index/, rebuild, and every number is
// identical — is a test here rather than a manual step, because it is the only
// thing standing between "a disposable cache" and "a second source of truth".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeStore } from './helpers.js';
import {
  rebuildIndex, readIndex, readIndexMeta, indexIsStale, ensureIndex,
  appendRun, clearIndex, indexLine, INDEX_VERSION
} from '../core/metricsIndex.js';
import { filterRows, rank, series, histogram, overview, facets } from '../core/investigate.js';

// A store with `n` runs, each carrying `calls` synthetic call records.
function seed(runs = 2, callsPer = 3, model = 'claude-sonnet-5') {
  const store = makeStore();
  const ids = [];
  for (let r = 0; r < runs; r++) {
    const runId = store.createRun(`run ${r}`);
    ids.push(runId);
    for (let c = 0; c < callsPer; c++) {
      store.writeCallRecord(runId, {
        v: 1, runId, nodeId: `node-${c}`, taskId: null, role: 'aiStep',
        attempt: 0, provider: 'anthropic', model,
        startedAt: new Date(Date.UTC(2026, 6, 10 + r, 12, c)).toISOString(),
        endedAt: new Date(Date.UTC(2026, 6, 10 + r, 12, c, 5)).toISOString(),
        durationMs: 1000 + c * 500, ttftMs: 200, outputTokensPerSec: 30,
        usage: { inputTokens: 1000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 100, reasoningTokens: 0, totalTokens: 1100 },
        cost: { total: 0.01, currency: 'USD', estimated: false, costKind: 'tokens' },
        finishReason: 'stop', error: null, ok: true, wire: null
      });
    }
  }
  return { store, ids };
}

test('rebuild produces one line per call and excludes pre-metrics runs', () => {
  const { store } = seed(2, 3);
  store.createRun('a run that never made a call'); // pre-metrics
  const meta = rebuildIndex(store);
  assert.equal(meta.version, INDEX_VERSION);
  assert.equal(meta.calls, 6);
  assert.equal(meta.runs.length, 2);
  assert.equal(meta.preMetricsRuns, 1);
  const rows = readIndex(store);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].model, 'claude-sonnet-5');
  assert.equal(rows[0].role, 'aiStep');
});

test('the index is disposable: delete it, rebuild, every number is identical', () => {
  // Verification item 7, as a test rather than a ritual.
  const { store } = seed(3, 4);
  rebuildIndex(store);
  const before = overview(readIndex(store));
  const leaderBefore = rank(readIndex(store));

  clearIndex(store);
  assert.equal(fs.existsSync(store.indexDir()), false);
  assert.equal(readIndex(store).length, 0);

  rebuildIndex(store);
  assert.deepEqual(overview(readIndex(store)), before);
  assert.deepEqual(rank(readIndex(store)), leaderBefore);
});

test('a missing, corrupt or version-behind index is stale and rebuilds silently', () => {
  const { store } = seed(1, 2);
  assert.equal(indexIsStale(store), true);          // never built
  ensureIndex(store);
  assert.equal(indexIsStale(store), false);

  // A schema bump: the app must not read lines it no longer understands.
  const p = path.join(store.indexDir(), 'meta.json');
  fs.writeFileSync(p, JSON.stringify({ ...readIndexMeta(store), version: 0 }), 'utf8');
  assert.equal(indexIsStale(store), true);
  ensureIndex(store);
  assert.equal(readIndexMeta(store).version, INDEX_VERSION);

  // A new run with calls the index has never seen.
  const runId = store.createRun('later');
  store.writeCallRecord(runId, { runId, nodeId: 'x', ok: true, provider: 'p', model: 'm', usage: null, cost: null });
  assert.equal(indexIsStale(store), true);
});

test('a torn last line costs that call, not the file', () => {
  const { store } = seed(1, 3);
  rebuildIndex(store);
  const p = path.join(store.indexDir(), 'calls.jsonl');
  fs.appendFileSync(p, '{"runId":"half-writ', 'utf8');
  assert.equal(readIndex(store).length, 3);
});

test('appendRun folds a finished run in without a full rebuild', () => {
  const { store } = seed(1, 2);
  rebuildIndex(store);
  const runId = store.createRun('a later run');
  store.writeCallRecord(runId, {
    runId, nodeId: 'n', role: 'aiStep', attempt: 0, provider: 'openai', model: 'gpt-5.2',
    startedAt: new Date().toISOString(), durationMs: 900, ttftMs: null, outputTokensPerSec: null,
    usage: { inputTokens: 5, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 5, reasoningTokens: 0, totalTokens: 10 },
    cost: { total: 0.001, costKind: 'tokens', estimated: false }, ok: true, wire: null
  });
  const meta = appendRun(store, runId);
  assert.equal(meta.calls, 3);
  assert.equal(readIndex(store).length, 3);
  assert.equal(indexIsStale(store), false);
  // Appending the SAME run again must not duplicate it — a re-run or a branch
  // rewrites history rather than adding to it.
  appendRun(store, runId);
  assert.equal(readIndex(store).length, 3);
});

test('runs/_index never lists as a run of its own', () => {
  const { store, ids } = seed(2, 1);
  rebuildIndex(store);
  assert.deepEqual(store.listRuns(), ids.sort());
  assert.equal(store.listRuns().includes('_index'), false);
});

// --- the queries -------------------------------------------------------------------

const row = (o = {}) => ({
  runId: 'r1', seq: 1, at: '2026-07-10T12:00:00.000Z', flowId: 'f1', nodeId: 'n1',
  role: 'aiStep', provider: 'anthropic', model: 'claude-sonnet-5', ok: true, attempt: 0,
  durationMs: 1000, ttftMs: 200, tps: 30, inTok: 1000, cachedTok: 0, outTok: 100,
  totalTok: 1100, cost: 0.01, costKind: 'tokens', estimated: false, ...o
});

test('rank marks a narrow sample rather than presenting it as a ranking', () => {
  // §10.4: organic history compares different prompts at different moments.
  const broad = Array.from({ length: 8 }, (_, i) => row({ model: 'broad', nodeId: `n${i}` }));
  const narrow = Array.from({ length: 8 }, () => row({ model: 'narrow', nodeId: 'n1' }));
  const table = rank([...broad, ...narrow]);
  assert.equal(table.find(r => r.key === 'broad').comparable, true);
  assert.equal(table.find(r => r.key === 'narrow').comparable, false);
  // No score field exists to be misread as a ranking.
  assert.equal('score' in table[0], false);
});

test('rank excludes plan calls from spend and keeps their tokens', () => {
  const table = rank([
    row({ model: 'm', cost: 0.02 }),
    row({ model: 'm', cost: null, costKind: 'plan', outTok: 500, totalTok: 1500 })
  ]);
  assert.equal(table[0].cost, 0.02);
  assert.equal(table[0].planCalls, 1);
  assert.equal(table[0].totalTok, 2600);
});

test('a failed attempt with no tokens does not make a total estimated', () => {
  const o = overview([row(), row({ ok: false, cost: null, totalTok: null, outTok: null })]);
  assert.equal(o.cost, 0.01);
  assert.equal(o.estimated, false);
  assert.equal(o.errors, 1);
});

test('series buckets by day and leaves empty days out rather than zeroing them', () => {
  const s = series([
    row({ at: '2026-07-10T09:00:00.000Z' }),
    row({ at: '2026-07-10T18:00:00.000Z' }),
    row({ at: '2026-07-13T09:00:00.000Z' })
  ], { bucket: 'day' });
  assert.deepEqual(s.map(b => b.at), ['2026-07-10', '2026-07-13']);
  assert.equal(s[0].calls, 2);
  assert.equal(s[0].cost, 0.02);
});

test('filterRows applies window, model and node-type filters together', () => {
  const rows = [
    row({ at: '2026-07-01T00:00:00.000Z', model: 'a', role: 'aiStep' }),
    row({ at: '2026-07-20T00:00:00.000Z', model: 'a', role: 'agentTask' }),
    row({ at: '2026-07-20T00:00:00.000Z', model: 'b', role: 'aiStep' })
  ];
  assert.equal(filterRows(rows, { since: '2026-07-10T00:00:00.000Z' }).length, 2);
  assert.equal(filterRows(rows, { models: ['a'] }).length, 2);
  assert.equal(filterRows(rows, { models: ['a'], roles: ['agentTask'] }).length, 1);
  assert.equal(filterRows(rows, {}).length, 3);
});

test('histogram keeps an outlier visible instead of flattening it away', () => {
  const h = histogram([...Array(50).fill(1000), 347_000]);
  assert.equal(h.min, 1000);
  assert.equal(h.max, 347_000);
  assert.equal(h.bins[0].count, 50);
  assert.equal(h.bins[h.bins.length - 1].count, 1);
  assert.equal(histogram([]), null);
});

test('facets are ordered by frequency, not alphabetically', () => {
  const f = facets([row({ model: 'zeta' }), row({ model: 'zeta' }), row({ model: 'alpha' })], 'model');
  assert.deepEqual(f, [{ value: 'zeta', count: 2 }, { value: 'alpha', count: 1 }]);
});

test('indexLine carries the run and flow a call belongs to', () => {
  const line = indexLine('run-1', { flowId: 'f', flowName: 'F', createdAt: '2026-07-10T00:00:00.000Z' }, {
    seq: 4, nodeId: 'n', role: 'aiStep', provider: 'p', model: 'm', ok: true, attempt: 0,
    startedAt: '2026-07-10T12:00:00.000Z', durationMs: 10, ttftMs: null, outputTokensPerSec: null,
    usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 3, totalTokens: 6 },
    cost: { total: 0.5, costKind: 'tokens', estimated: true }
  });
  assert.equal(line.runId, 'run-1');
  assert.equal(line.flowName, 'F');
  assert.equal(line.cachedTok, 2);
  assert.equal(line.estimated, true);
  // Wire pointers and error text stay out: every field costs a full scan.
  assert.equal('wire' in line, false);
  assert.equal('error' in line, false);
});
