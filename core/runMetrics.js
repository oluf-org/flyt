// Run metrics (PIVOT-PLAN P3) — the ledger, folded into what a run surface
// shows.
//
// Everything here is DERIVED. The records under runs/<id>/calls/ are the truth;
// this module never writes and never caches, so a number on screen can always
// be re-derived from files by hand. It is also pure, so the same fold runs in
// the main process (for the snapshot) and in P4's cross-run index.
import { sumCosts, sumUsage } from './callCost.js';

// The run-record format (PIVOT-PLAN decision 15). v1 = every run written before
// the call ledger existed; v2 = runs that carry runs/<id>/calls/. Old runs are
// NOT migrated — they are excluded from aggregates and labelled, because
// inventing metrics for a run that never measured any is exactly the lie an
// investigator product cannot afford. core/state.js re-exports both.
export const RUN_RECORD_VERSION = 2;

export function hasMetrics(meta) {
  return Number(meta?.recordVersion ?? 1) >= RUN_RECORD_VERSION;
}

// Percentiles from a small sample, nearest-rank. p50/p95/max rather than an
// average, because an average is exactly what hid the 347-second hang in
// DESIGN-SPEC §11.1 among a hundred fast calls (§6.2.3).
export function percentiles(values) {
  const v = (values ?? []).filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = p => v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
  return { n: v.length, p50: at(50), p95: at(95), max: v[v.length - 1], min: v[0] };
}

// One node's (or task's) slice of the ledger.
function fold(calls) {
  const usage = sumUsage(calls.map(c => c.usage));
  const ok = calls.filter(c => c.ok);
  const failed = calls.filter(c => !c.ok);
  // An attempt that died before the provider reported any usage has no cost to
  // add — a 429 refused the request, it did not bill for it. Feeding its null
  // cost to sumCosts would mark the whole run "estimated" on the strength of a
  // call that provably cost nothing, which is the wrong kind of caution: it
  // makes the ~ meaningless by putting it on almost every run.
  const cost = sumCosts(calls.filter(c => c.ok || c.usage).map(c => c.cost));
  return {
    calls: calls.length,
    // Attempts beyond the first. "5 calls, 2 of them retries" is the sentence
    // this makes sayable, and retries are the first thing the investigator
    // shows when a node was slow (§4.2).
    retries: calls.filter(c => (c.attempt ?? 0) > 0).length,
    errors: failed.length,
    // Time spent inside model calls. Not wall time: parallel agentTasks overlap,
    // so summing them would exceed the run's own duration — deliberately a
    // different number with a different name.
    modelMs: calls.reduce((n, c) => n + (typeof c.durationMs === 'number' ? c.durationMs : 0), 0),
    usage,
    cost,
    latency: percentiles(ok.map(c => c.durationMs)),
    ttft: percentiles(ok.map(c => c.ttftMs)),
    throughput: percentiles(ok.map(c => c.outputTokensPerSec)),
    models: [...new Set(calls.map(c => c.model).filter(Boolean))],
    providers: [...new Set(calls.map(c => c.provider).filter(Boolean))],
    lastError: failed.length ? failed[failed.length - 1].error : null,
    // A node whose last attempt failed but which has a later successful one
    // recovered; the badge should say so rather than showing a red node.
    recovered: Boolean(failed.length && ok.length)
  };
}

// The metrics block that rides on a run snapshot.
//
//   { version, preMetrics, run, nodes: { [id]: … }, tasks: { [id]: … },
//     inFlight: [ … ] }
//
// `preMetrics` is the honest label for a run written before the ledger existed
// (decision 15, clean break): its numbers are absent, not zero.
export function runMetrics(calls, meta = null) {
  const list = Array.isArray(calls) ? calls : [];
  const version = Number(meta?.recordVersion ?? 1);
  const byNode = {};
  const byTask = {};
  for (const c of list) {
    if (c.nodeId) (byNode[c.nodeId] ??= []).push(c);
    if (c.taskId) (byTask[c.taskId] ??= []).push(c);
  }
  return {
    version,
    preMetrics: version < RUN_RECORD_VERSION && list.length === 0,
    run: fold(list),
    nodes: Object.fromEntries(Object.entries(byNode).map(([k, v]) => [k, fold(v)])),
    tasks: Object.fromEntries(Object.entries(byTask).map(([k, v]) => [k, fold(v)]))
  };
}

// The per-attempt list the Inspector's Calls tab shows for one node: the raw
// records, trimmed of the bulky bits a list doesn't need. Selecting one opens
// the wire viewer, which reads the files themselves.
export function callsForNode(calls, nodeId, taskId = null) {
  return (calls ?? [])
    .filter(c => (nodeId && c.nodeId === nodeId) || (taskId && c.taskId === taskId))
    .map(({ rawUsage, ...c }) => c);
}

// "2m 14s", "8.4s", "640ms" — durations at three scales, because a run header
// and a time-to-first-token badge are not the same size of number.
export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

// "12.4k", "1.2M", "243". Token counts are read at a glance, not audited, and a
// column of seven-digit numbers is a column nobody reads.
export function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
