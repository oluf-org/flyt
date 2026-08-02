import React from 'react';
import { formatMs, formatTokens } from '../core/runMetrics.js';
import { formatCost } from '../core/callCost.js';
import Tip from './Tip.jsx';

// The metrics surface on a run (PIVOT-PLAN §6.1) — the first place the pivot is
// felt. Everything here reads the `metrics` block on the run snapshot, which is
// a fold of runs/<id>/calls/. Nothing is computed twice: the same
// core/runMetrics.js the main process used produces the strings.
//
// Motion policy (D9): numbers tick, nothing spins. A live run's cost climbing is
// legible; a spinner next to it is noise.

// A cost figure that never lies. `estimated` prints a ~, `plan` says so, and an
// unpriceable total prints an em dash rather than $0 — the whole point of
// core/callCost.js rule 2 is that a fabricated zero is worse than a blank.
export function Cost({ cost, className = '' }) {
  if (!cost) return <span className={'metric-value ' + className}>—</span>;
  const planOnly = cost.total == null && cost.plan > 0 && cost.priced === 0;
  if (planOnly) {
    return (
      <Tip as="span" className={'metric-value ' + className} text="Ran on a subscription — this costs plan capacity, not dollars">
        plan
      </Tip>
    );
  }
  const text = formatCost(cost.total);
  if (cost.total == null) {
    return (
      <Tip as="span" className={'metric-value dim ' + className} text="No published price for this model — the app will not invent one">
        {text}
      </Tip>
    );
  }
  return (
    <Tip
      as="span" className={'metric-value ' + className}
      text={cost.estimated
        ? 'Approximate: at least one call had no published price for part of its usage'
        : `Exact, priced from ${cost.priceSource ?? 'the model catalog'}`}
    >
      {cost.estimated ? '~' : ''}{text}
      {cost.plan > 0 && <span className="metric-note"> +{cost.plan} on plan</span>}
    </Tip>
  );
}

// The run header's strip: total cost, total tokens, calls, retries, model time.
// `elapsedMs` is wall time and comes from the run itself — deliberately distinct
// from modelMs, which sums calls that may have run in parallel.
export function RunMetricStrip({ metrics }) {
  if (!metrics) return null;
  if (metrics.preMetrics) {
    return (
      <Tip as="span" className="run-stat run-stat-premetrics"
        text="This run predates the call ledger. Its numbers were never measured, so none are shown.">
        pre-metrics
      </Tip>
    );
  }
  const r = metrics.run;
  if (!r?.calls) return null;
  const tokens = r.usage?.totalTokens ?? null;
  return (
    <>
      <Tip as="span" className="run-stat metric" text="What this run has spent so far">
        <span className="metric-label">cost</span> <Cost cost={r.cost} />
      </Tip>
      <Tip as="span" className="run-stat metric mono" text={tokenBreakdown(r.usage)}>
        <span className="metric-label">tok</span> {formatTokens(tokens)}
      </Tip>
      <Tip as="span" className="run-stat metric mono"
        text={`${r.calls} model call${r.calls === 1 ? '' : 's'}, ${formatMs(r.modelMs)} spent inside them (calls may overlap)`}>
        <span className="metric-label">calls</span> {r.calls}
      </Tip>
      {r.retries > 0 && (
        <Tip as="span" className="run-stat metric mono warn"
          text="Attempts that failed and were retried. Retries cost money and add latency.">
          <span className="metric-label">retries</span> {r.retries}
        </Tip>
      )}
    </>
  );
}

function tokenBreakdown(u) {
  if (!u) return 'No token usage reported';
  const parts = [
    `${formatTokens(u.inputTokens)} in`,
    u.cachedInputTokens ? `${formatTokens(u.cachedInputTokens)} cached` : null,
    u.cacheWriteTokens ? `${formatTokens(u.cacheWriteTokens)} cache-write` : null,
    `${formatTokens(u.outputTokens)} out`,
    u.reasoningTokens ? `${formatTokens(u.reasoningTokens)} reasoning` : null
  ].filter(Boolean);
  return parts.join(' · ');
}

// The badge on a node card: what this node has cost and produced, plus an
// attempt marker when a call is retrying. Small on purpose — the card is
// primarily about output, and the numbers are a second glance, not a dashboard.
export function NodeMetricBadge({ node, live = false }) {
  if (!node?.calls) return null;
  const tps = node.throughput?.p50 ?? null;
  return (
    <span className={'node-metrics' + (live ? ' live' : '')}>
      <Cost cost={node.cost} className="node-metric-cost" />
      {node.usage?.totalTokens ? (
        <span className="node-metric mono" title={tokenBreakdown(node.usage)}>
          {formatTokens(node.usage.totalTokens)}
        </span>
      ) : null}
      {tps ? <span className="node-metric mono" title="Output tokens per second (median)">{tps} t/s</span> : null}
      {node.retries > 0 && (
        <span className="node-metric attempt" title={`${node.retries} retried attempt(s) — ${node.lastError ?? ''}`}>
          ↻{node.retries}
        </span>
      )}
    </span>
  );
}

// p50 / p95 / max, the shape §6.2.3 asks for. An average would have hidden the
// 347-second hang in DESIGN-SPEC §11.1 among a hundred fast calls.
export function Distribution({ label, dist, unit = 'ms' }) {
  if (!dist) return null;
  const fmt = unit === 'ms' ? formatMs : (n => `${n}`);
  return (
    <div className="dist-row">
      <span className="dist-label">{label}</span>
      <span className="dist-values mono">
        <span title="median">{fmt(dist.p50)}</span>
        <span className="dist-sep">·</span>
        <span title="95th percentile">p95 {fmt(dist.p95)}</span>
        <span className="dist-sep">·</span>
        <span title="slowest">max {fmt(dist.max)}</span>
      </span>
    </div>
  );
}
