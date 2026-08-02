import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LineChart, Histogram, BoxRows } from './charts.jsx';
import { formatCost } from '../core/callCost.js';
import { formatMs, formatTokens } from '../core/runMetrics.js';
import Tip from './Tip.jsx';

// The Investigator page (PIVOT-PLAN §6.2) — the three things a single run
// cannot answer:
//
//   1. Model leaderboard         cost, latency, throughput per model
//   2. Spend and usage over time trended across runs
//   3. Latency and throughput    distributions, p50/p95/max
//
// Everything on this page comes from runs/_index/calls.jsonl, which is derived
// from runs/*/calls/*.json and is DISPOSABLE. The "Rebuild index" button in the
// footer is not a repair tool — it is verification item 7 made clickable: delete
// it, rebuild it, and every number here must be identical.
//
// §10.4 (leaderboard honesty) is answered structurally: organic run history
// compares different prompts at different moments, so this page shows
// DISTRIBUTIONS and marks any model whose sample came from too few distinct
// tasks. Rankings wait for sweeps (P9), which produce controlled data.

const WINDOWS = [
  ['7d', 'Last 7 days', 7],
  ['30d', 'Last 30 days', 30],
  ['90d', 'Last 90 days', 90],
  ['all', 'All time', null]
];
const GROUPS = [['model', 'Model'], ['provider', 'Provider'], ['role', 'Node type'], ['flowId', 'Flow']];

export default function Investigator({ projectId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [win, setWin] = useState('30d');
  const [by, setBy] = useState('model');
  const [models, setModels] = useState([]);
  const [roles, setRoles] = useState([]);

  const filters = useMemo(() => {
    const days = WINDOWS.find(w => w[0] === win)?.[2] ?? null;
    return {
      by,
      bucket: days != null && days <= 7 ? 'day' : days != null && days <= 30 ? 'day' : 'week',
      ...(days != null ? { since: new Date(Date.now() - days * 86_400_000).toISOString() } : {}),
      ...(models.length ? { models } : {}),
      ...(roles.length ? { roles } : {})
    };
  }, [win, by, models, roles]);

  const load = useCallback(() => {
    if (!window.flyt?.queryMetrics) { setData(null); setError('Metrics are only available in the app.'); return; }
    setBusy(true);
    window.flyt.queryMetrics(projectId, filters)
      .then(r => { setData(r); setError(null); })
      .catch(err => setError(String(err?.message ?? err)))
      .finally(() => setBusy(false));
  }, [projectId, filters]);

  useEffect(() => { load(); }, [load]);

  const rebuild = async () => {
    setBusy(true);
    try { await window.flyt.rebuildMetrics(projectId); load(); }
    catch (err) { setError(String(err?.message ?? err)); setBusy(false); }
  };

  const toggle = (list, set, value) =>
    set(list.includes(value) ? list.filter(v => v !== value) : [...list, value]);

  if (error) return <div className="page investigator"><div className="page-empty">{error}</div></div>;
  if (!data) return <div className="page investigator"><div className="page-empty">Reading the ledger…</div></div>;

  const o = data.overview;
  const noData = o.calls === 0;

  return (
    <div className={'page investigator' + (busy ? ' busy' : '')}>
      <header className="inv-head">
        <div>
          <h1>Investigator</h1>
          <p className="inv-sub">
            {noData
              ? 'Nothing recorded yet in this window.'
              : <>{o.calls.toLocaleString()} call{o.calls === 1 ? '' : 's'} across {o.runs} run{o.runs === 1 ? '' : 's'}
                {data.total > o.calls && <span className="dim"> · {data.total.toLocaleString()} recorded in total</span>}</>}
          </p>
        </div>
        <div className="inv-filters">
          <div className="seg" role="group" aria-label="Time window">
            {WINDOWS.map(([k, label]) => (
              <button key={k} type="button" className={'seg-btn' + (win === k ? ' active' : '')}
                onClick={() => setWin(k)}>{label.replace('Last ', '')}</button>
            ))}
          </div>
        </div>
      </header>

      {noData ? (
        <div className="page-empty">
          <p>No model calls have been recorded in this window.</p>
          <p className="dim">
            Every run since the call ledger landed records what each model call cost, sent and
            returned. Runs made before that are excluded rather than shown as zeros
            {data.index?.preMetricsRuns ? ` — ${data.index.preMetricsRuns} of them here.` : '.'}
          </p>
        </div>
      ) : (
        <>
          <section className="inv-tiles">
            <Tile label="spend" value={`${o.estimated ? '~' : ''}${formatCost(o.cost)}`}
              note={o.planCalls ? `${o.planCalls} call(s) on a subscription plan` : (o.estimated ? 'at least one call had no published price' : 'exact')} />
            <Tile label="tokens" value={formatTokens(o.tokens)} note={`${formatTokens(o.outTokens)} generated`} />
            <Tile label="median latency" value={formatMs(o.latency?.p50)} note={`p95 ${formatMs(o.latency?.p95)} · max ${formatMs(o.latency?.max)}`} />
            <Tile label="retries" value={String(o.retries)} note={o.errors ? `${o.errors} failed attempt(s)` : 'no failed attempts'} />
          </section>

          <section className="inv-section">
            <div className="inv-section-head">
              <h2>Spend over time</h2>
              <span className="inv-note">
                Subscription calls are excluded from dollars and included in tokens.
              </span>
            </div>
            <LineChart
              points={data.spend.map(b => ({ at: b.at, value: b.cost ?? 0 }))}
              format={n => formatCost(n)}
              label="spend per bucket"
            />
            <LineChart
              points={data.spend.map(b => ({ at: b.at, value: b.tokens }))}
              format={formatTokens}
              label="tokens per bucket"
              height={110}
            />
          </section>

          <section className="inv-section">
            <div className="inv-section-head">
              <h2>Latency</h2>
              <span className="inv-note">
                Every completed attempt in this window. p95 marked, because an average would
                describe no call that actually happened.
              </span>
            </div>
            <Histogram hist={data.latency} format={formatMs} label="call latency" p95={o.latency?.p95} />
          </section>

          {data.throughput && (
            <section className="inv-section">
              <div className="inv-section-head">
                <h2>Throughput</h2>
                <span className="inv-note">Output tokens per second, streaming calls only.</span>
              </div>
              <Histogram hist={data.throughput} format={n => `${Math.round(n)} t/s`} label="throughput" p95={o.throughput?.p95} />
            </section>
          )}

          <section className="inv-section">
            <div className="inv-section-head">
              <h2>By {GROUPS.find(g => g[0] === by)?.[1].toLowerCase()}</h2>
              <div className="seg" role="group" aria-label="Group by">
                {GROUPS.map(([k, label]) => (
                  <button key={k} type="button" className={'seg-btn' + (by === k ? ' active' : '')}
                    onClick={() => setBy(k)}>{label}</button>
                ))}
              </div>
            </div>
            <p className="inv-warn">
              These are <strong>distributions, not a ranking</strong>. Organic run history compares
              different prompts at different moments; a row marked <em>narrow</em> was measured on
              too few distinct tasks to sit beside the others as evidence. Use a sweep for a
              controlled comparison.
            </p>
            <BoxRows
              rows={data.leaderboard.map(r => ({ key: r.key, dist: r.latency, comparable: r.comparable }))}
              format={formatMs}
              label="latency by group"
            />
            <Leaderboard rows={data.leaderboard} by={by} />
          </section>

          {data.facets?.model?.length > 1 && (
            <section className="inv-section">
              <div className="inv-section-head"><h2>Filter</h2></div>
              <FacetChips label="Models" facet={data.facets.model} selected={models} onToggle={v => toggle(models, setModels, v)} />
              <FacetChips label="Node types" facet={data.facets.role} selected={roles} onToggle={v => toggle(roles, setRoles, v)} />
            </section>
          )}
        </>
      )}

      <footer className="inv-foot">
        <span className="dim">
          Derived from <code>runs/_index/calls.jsonl</code>
          {data.index?.builtAt ? ` · built ${data.index.builtAt.replace('T', ' ').slice(0, 16)}` : ''}
          {data.index?.calls != null ? ` · ${data.index.calls.toLocaleString()} line(s)` : ''}
        </span>
        <Tip
          as="button" type="button" className="ghost mini" onClick={rebuild} disabled={busy}
          text="Delete and regenerate the index from runs/*/calls/. Nothing is lost — every number here is derived, and rebuilding must produce exactly the same figures."
        >Rebuild index</Tip>
      </footer>
    </div>
  );
}

function Tile({ label, value, note }) {
  return (
    <div className="inv-tile">
      <div className="inv-tile-label">{label}</div>
      <div className="inv-tile-value mono">{value}</div>
      <div className="inv-tile-note">{note}</div>
    </div>
  );
}

function FacetChips({ label, facet, selected, onToggle }) {
  if (!facet?.length) return null;
  return (
    <div className="facet-row">
      <span className="facet-label">{label}</span>
      <div className="facet-chips">
        {facet.slice(0, 16).map(f => (
          <button
            key={f.value} type="button"
            className={'facet-chip' + (selected.includes(f.value) ? ' on' : '')}
            onClick={() => onToggle(f.value)}
          >{f.value} <span className="facet-count">{f.count}</span></button>
        ))}
      </div>
    </div>
  );
}

function Leaderboard({ rows, by }) {
  return (
    <div className="inv-table-wrap">
      <table className="inv-table">
        <thead>
          <tr>
            <th>{GROUPS.find(g => g[0] === by)?.[1] ?? by}</th>
            <th className="num">calls</th>
            <th className="num">spend</th>
            <th className="num">per 1k out</th>
            <th className="num">p50</th>
            <th className="num">p95</th>
            <th className="num">tok/s</th>
            <th className="num">errors</th>
            <th>sample</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.key} className={r.comparable ? '' : 'narrow'}>
              <td className="mono">{r.key}</td>
              <td className="num mono">{r.calls}</td>
              <td className="num mono">
                {r.planCalls === r.calls ? <span className="dim">plan</span> : `${r.estimated ? '~' : ''}${formatCost(r.cost)}`}
              </td>
              <td className="num mono">{r.costPerKOut == null ? <span className="dim">—</span> : formatCost(r.costPerKOut)}</td>
              <td className="num mono">{formatMs(r.latency?.p50)}</td>
              <td className="num mono">{formatMs(r.latency?.p95)}</td>
              <td className="num mono">{r.throughput?.p50 ?? <span className="dim">—</span>}</td>
              <td className="num mono">{r.errors || <span className="dim">0</span>}</td>
              <td className="sample">
                {r.comparable
                  ? <span className="dim">{r.nodes} distinct tasks</span>
                  : <Tip as="span" className="sample-narrow" text={`Only ${r.nodes} distinct task(s) and ${r.calls} call(s). Not enough spread to compare against a broad sample.`}>narrow</Tip>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
