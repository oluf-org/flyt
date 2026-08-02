// The Investigator page's queries (PIVOT-PLAN §6.2) — the three things a
// single run cannot answer.
//
//   1. Model leaderboard        cost, latency, throughput per model
//   2. Spend and usage over time trended across runs
//   3. Latency distributions    p50/p95/max, never an average
//
// Pure functions over index lines (core/metricsIndex.js). No I/O, no dates
// beyond parsing, no formatting — so the same code answers the page, the CLI
// and any test, and a number on screen is one function call from a file.
//
// Open question §10.4 — leaderboard honesty — is answered structurally rather
// than in prose: `rank()` returns DISTRIBUTIONS and a `comparable` flag, never a
// score. Organic run history compares different prompts at different moments;
// presenting that as a ranking would be the exact dishonesty this whole product
// exists to remove. Sweeps (P9) produce controlled samples and get to rank.
import { percentiles } from './runMetrics.js';

// Should this call have produced a dollar figure? A subscription call should
// not (it costs plan capacity), and neither should an attempt that died before
// the provider reported any usage — a 429 refused the request, it did not bill
// for it. Counting those as "unpriced" would put a ~ on almost every total and
// make the marker meaningless. Same rule as the per-run fold in
// core/runMetrics.js, for the same reason.
const billable = r => r.costKind !== 'plan' && (r.ok || r.totalTok);

// --- filtering -------------------------------------------------------------------

// Every filter the page offers, applied in one pass. All fields are optional;
// an absent filter matches everything.
export function filterRows(rows, {
  since = null, until = null, models = null, providers = null,
  flowIds = null, roles = null, okOnly = false
} = {}) {
  const inSet = (set, v) => !set || set.length === 0 || set.includes(v);
  const from = since ? Date.parse(since) : null;
  const to = until ? Date.parse(until) : null;
  return (rows ?? []).filter(r => {
    if (okOnly && !r.ok) return false;
    if (!inSet(models, r.model) || !inSet(providers, r.provider)) return false;
    if (!inSet(flowIds, r.flowId) || !inSet(roles, r.role)) return false;
    if (from != null || to != null) {
      const t = Date.parse(r.at ?? '');
      if (!Number.isFinite(t)) return false;
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
    }
    return true;
  });
}

// --- 1. the leaderboard ------------------------------------------------------------

// Per-model rows for the leaderboard. `by` groups on any index field, so the
// same function slices by node type (`role`) or by flow, which is what §6.2.1
// means by "sliceable by node type".
export function rank(rows, { by = 'model' } = {}) {
  const groups = new Map();
  for (const r of rows ?? []) {
    const key = r[by] ?? '(unknown)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  for (const [key, rs] of groups) {
    const ok = rs.filter(r => r.ok);
    const priced = rs.filter(r => typeof r.cost === 'number');
    const planCalls = rs.filter(r => r.costKind === 'plan').length;
    const outTok = sum(ok.map(r => r.outTok));
    const cost = priced.length ? round(sum(priced.map(r => r.cost))) : null;
    out.push({
      key,
      calls: rs.length,
      runs: new Set(rs.map(r => r.runId)).size,
      // How many DISTINCT things this model was asked to do. One prompt run
      // fifty times and fifty different prompts are not the same evidence, and
      // the page has to be able to say which it is looking at.
      nodes: new Set(rs.map(r => `${r.flowId ?? ''}:${r.nodeId ?? ''}`)).size,
      errors: rs.length - ok.length,
      errorRate: rs.length ? round((rs.length - ok.length) / rs.length, 4) : 0,
      retries: rs.filter(r => r.attempt > 0).length,
      inTok: sum(rs.map(r => r.inTok)),
      cachedTok: sum(rs.map(r => r.cachedTok)),
      outTok,
      totalTok: sum(rs.map(r => r.totalTok)),
      cost,
      planCalls,
      estimated: priced.some(r => r.estimated) || priced.length < rs.filter(billable).length,
      // Cost per 1000 output tokens: the closest thing to a comparable unit
      // price that organic history can honestly produce, and null the moment it
      // would be division by an unpriced or plan-priced sample.
      costPerKOut: cost != null && outTok > 0 ? round((cost / outTok) * 1000, 6) : null,
      latency: percentiles(ok.map(r => r.durationMs)),
      ttft: percentiles(ok.map(r => r.ttftMs)),
      throughput: percentiles(ok.map(r => r.tps)),
      // §10.4: is this sample comparable to the others, or just plentiful? A
      // model seen on one node of one flow has been measured on one task; the
      // page must not let that sit next to a broad sample as though the two
      // rows meant the same thing.
      comparable: new Set(rs.map(r => `${r.flowId ?? ''}:${r.nodeId ?? ''}`)).size >= 3 && rs.length >= 5
    });
  }
  return out.sort((a, b) => b.calls - a.calls);
}

// --- 2. spend and usage over time -----------------------------------------------------

// Bucketed series. `bucket` is 'hour' | 'day' | 'week'; `by` optionally splits
// each bucket by a field (model, flow, provider) for a stacked view.
export function series(rows, { bucket = 'day', by = null } = {}) {
  const buckets = new Map();
  for (const r of rows ?? []) {
    const t = Date.parse(r.at ?? '');
    if (!Number.isFinite(t)) continue;
    const key = bucketKey(t, bucket);
    if (!buckets.has(key)) buckets.set(key, new Map());
    const inner = buckets.get(key);
    const sub = by ? (r[by] ?? '(unknown)') : '';
    if (!inner.has(sub)) inner.set(sub, { cost: null, tokens: 0, calls: 0, planCalls: 0 });
    const cell = inner.get(sub);
    cell.calls += 1;
    cell.tokens += r.totalTok ?? 0;
    if (r.costKind === 'plan') cell.planCalls += 1;
    if (typeof r.cost === 'number') cell.cost = (cell.cost ?? 0) + r.cost;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([at, inner]) => ({
      at,
      parts: [...inner.entries()].map(([key, v]) => ({ key, ...v, cost: round(v.cost) })),
      cost: round([...inner.values()].reduce((n, v) => (v.cost == null ? n : (n ?? 0) + v.cost), null)),
      tokens: [...inner.values()].reduce((n, v) => n + v.tokens, 0),
      calls: [...inner.values()].reduce((n, v) => n + v.calls, 0)
    }));
}

// ISO-ish bucket keys that sort lexically, so no date maths is needed downstream.
function bucketKey(t, bucket) {
  const d = new Date(t);
  const iso = d.toISOString();
  if (bucket === 'hour') return iso.slice(0, 13) + ':00';
  if (bucket === 'week') {
    // Monday of the containing week — a week bucket labelled by its first day
    // is the one form that stays readable next to day buckets.
    const day = (d.getUTCDay() + 6) % 7;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
    return monday.toISOString().slice(0, 10);
  }
  return iso.slice(0, 10);
}

// --- 3. distributions -----------------------------------------------------------------

// A histogram for the latency/throughput view. Fixed bucket COUNT with bounds
// derived from the data, so a run of uniformly fast calls still fills the plot
// instead of collapsing into the first bar.
export function histogram(values, { buckets = 24 } = {}) {
  const v = (values ?? []).filter(n => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const min = v[0];
  const max = v[v.length - 1];
  if (min === max) return { min, max, width: 0, bins: [{ from: min, to: max, count: v.length }] };
  const width = (max - min) / buckets;
  const bins = Array.from({ length: buckets }, (_, i) => ({
    from: min + i * width, to: min + (i + 1) * width, count: 0
  }));
  for (const n of v) {
    const i = Math.min(buckets - 1, Math.floor((n - min) / width));
    bins[i].count += 1;
  }
  return { min, max, width, bins };
}

// The headline numbers above the charts.
export function overview(rows) {
  const list = rows ?? [];
  const ok = list.filter(r => r.ok);
  const priced = list.filter(r => typeof r.cost === 'number');
  return {
    calls: list.length,
    runs: new Set(list.map(r => r.runId)).size,
    models: new Set(list.map(r => r.model).filter(Boolean)).size,
    errors: list.length - ok.length,
    retries: list.filter(r => r.attempt > 0).length,
    cost: priced.length ? round(sum(priced.map(r => r.cost))) : null,
    planCalls: list.filter(r => r.costKind === 'plan').length,
    estimated: priced.some(r => r.estimated) || priced.length < list.filter(billable).length,
    tokens: sum(list.map(r => r.totalTok)),
    outTokens: sum(list.map(r => r.outTok)),
    latency: percentiles(ok.map(r => r.durationMs)),
    ttft: percentiles(ok.map(r => r.ttftMs)),
    throughput: percentiles(ok.map(r => r.tps)),
    // The window the numbers actually cover, so a filtered view can say so.
    from: list.reduce((m, r) => (r.at && (!m || r.at < m) ? r.at : m), null),
    to: list.reduce((m, r) => (r.at && (!m || r.at > m) ? r.at : m), null)
  };
}

// Every distinct value of a field, for the filter chips. Sorted by frequency:
// the model you actually use should not be alphabetically buried.
export function facets(rows, field) {
  const counts = new Map();
  for (const r of rows ?? []) {
    const v = r[field];
    if (v == null) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

const sum = xs => xs.reduce((n, x) => n + (typeof x === 'number' ? x : 0), 0);
const round = (n, dp = 10) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
