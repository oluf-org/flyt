import React, { useEffect, useMemo, useRef, useState } from 'react';
import ActivityIcon from '../ActivityIcon.jsx';
import { elapsed, loopLabel } from '../activityFormat.js';
import './historyStyles.css';

const pct = value => value == null ? '—' : `${(value * 100).toFixed(1)}%`;
const integer = value => value == null ? '—' : Math.round(value).toLocaleString();
const money = value => value == null ? '—' : `$${Number(value).toFixed(value < 1 ? 4 : 2)}`;
const duration = value => value == null ? '—' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
const short = value => String(value ?? '').length > 24 ? `${String(value).slice(0, 12)}…${String(value).slice(-7)}` : String(value ?? '');

function since(range) {
  if (range === 'all') return null;
  const days = Number(range) || 30;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function Stat({ label, value, detail = null }) {
  return <div className="history-stat"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>;
}

function Ratio({ label, value }) {
  return <div className="history-ratio"><div><span>{label}</span><strong>{pct(value)}</strong></div><div className="history-ratio-track"><i style={{ width: `${Math.max(0, Math.min(1, value ?? 0)) * 100}%` }} /></div></div>;
}

function TraceTimeline({ run, events, busy, onClose }) {
  return <aside className="history-trace" aria-label={`Technical trace ${run?.runId ?? ''}`}>
    <header><div><span className="section-label">TECHNICAL TRACE</span><h2>{short(run?.runId)}</h2><p>{events.length} immutable events · schema v{events[0]?.schemaVersion ?? 1}</p></div><button onClick={onClose} aria-label="Close trace">×</button></header>
    {busy ? <p className="history-empty">Loading trace…</p> : !events.length ? <p className="history-empty">No normalized events are stored for this run yet.</p> : <div className="history-timeline">
      {events.map(event => <details key={event.eventId} className={`history-event source-${event.source}`}>
        <summary><i /><time>{new Date(event.at).toLocaleTimeString()}</time><strong>{event.kind}</strong><span>{event.blockId ?? event.taskId ?? event.source}</span></summary>
        <div className="history-event-body">
          <dl><dt>Source</dt><dd>{event.source}</dd><dt>Span</dt><dd className="mono">{event.spanId}</dd>{event.parentSpanId && <><dt>Parent</dt><dd className="mono">{event.parentSpanId}</dd></>}</dl>
          {Object.keys(event.measurements ?? {}).length > 0 && <><h4>Measurements</h4><pre>{JSON.stringify(event.measurements, null, 2)}</pre></>}
          {Object.keys(event.attributes ?? {}).length > 0 && <><h4>Metadata</h4><pre>{JSON.stringify(event.attributes, null, 2)}</pre></>}
          {event.attributes?.artifact && event.projectId && <button className="history-artifact" onClick={() => window.flyt.openRunArtifact(event.projectId, event.runId, event.attributes.artifact)}>Open complete tool result</button>}
        </div>
      </details>)}
    </div>}
  </aside>;
}

export default function HistoryPage({ onOpenLoop }) {
  const [tab, setTab] = useState('loops');
  const [revision, setRevision] = useState(0);
  const traceRequest = useRef(0);
  const [range, setRange] = useState('30');
  const [model, setModel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [trace, setTrace] = useState([]);
  const [traceBusy, setTraceBusy] = useState(false);
  const filters = useMemo(() => ({ from: since(range), model: model || null, projectId: projectId || null }), [range, model, projectId]);

  useEffect(() => {
    let live = true; setBusy(true); setError('');
    traceRequest.current++; setSelected(null); setTrace([]);
    window.flyt.historySummary(filters).then(next => { if (live) setData(next); })
      .catch(err => { if (live) setError(String(err?.message ?? err)); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [filters, revision]);

  async function openTrace(run) {
    const request = ++traceRequest.current;
    setSelected(run); setTrace([]); setTraceBusy(true);
    try { const next = await window.flyt.historyTrace(run.runId); if (request === traceRequest.current) setTrace(next); }
    catch (err) { if (request === traceRequest.current) setError(String(err?.message ?? err)); }
    finally { if (request === traceRequest.current) setTraceBusy(false); }
  }

  const totals = data?.totals ?? {};
  return <div className="history-page">
    <header className="history-head">
      <div><h1>Statistics</h1></div>
      <div className="history-actions"><button disabled={busy} onClick={() => setRevision(value => value + 1)}>Refresh</button><button onClick={() => window.flyt.exportHistory('jsonl', filters).catch(err => setError(String(err.message ?? err)))}>JSONL ↓</button><button onClick={() => window.flyt.exportHistory('csv', filters).catch(err => setError(String(err.message ?? err)))}>CSV ↓</button></div>
    </header>
    <div className="history-filters">
      <label>Range<select value={range} onChange={e => setRange(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="all">All time</option></select></label>
      <label>Model<select value={model} onChange={e => setModel(e.target.value)}><option value="">All models</option>{data?.facets?.models?.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Project<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">All projects</option>{data?.facets?.projects?.map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <div className="history-tabs" role="group" aria-label="Statistics type"><button aria-pressed={tab === 'loops'} onClick={() => setTab('loops')}>Loops</button><button aria-pressed={tab === 'models'} onClick={() => setTab('models')}>Models &amp; workflows</button></div>
    {error && <div className="history-error">{error}</div>}
    {busy ? <div className="history-empty" role="status">Loading statistics…</div> : tab === 'loops' ? <>
      <section className="history-stats" aria-label="Loop totals">
        <Stat label="Loops" value={integer(data?.loops?.totals.count ?? 0)}/>
        <Stat label="Achieved" value={integer(data?.loops?.totals.achieved ?? 0)} detail={`${pct(data?.loops?.totals.successRate)} of settled loops`}/>
        <Stat label="Iterations" value={integer(data?.loops?.totals.iterations ?? 0)}/>
        <Stat label="Average active time" value={elapsed(data?.loops?.totals.averageElapsedMs)}/>
        <Stat label="Known cost" value={money(data?.loops?.totals.knownUsd ?? 0)} detail={data?.loops?.totals.unknownCostCalls ? `${integer(data.loops.totals.unknownCostCalls)} unpriced calls` : null}/>
      </section>
      <section className="history-card history-table-card"><div className="history-table-wrap"><table><thead><tr><th>Loop</th><th>Outcome</th><th>Checks</th><th>Iterations</th><th>Active time</th><th>Calls</th><th>Tokens</th><th>Known cost</th></tr></thead><tbody>
        {data?.loops?.rows?.map(row => <tr key={`${row.projectId}:${row.id}`}><td><button className="history-loop-link" onClick={() => onOpenLoop?.(row)} title={row.name}><ActivityIcon kind="loop" id={row.id} size={22}/><span><strong>{row.name}</strong><small>{new Date(row.createdAt).toLocaleDateString()}</small></span></button></td>
          <td><span className={`history-loop-outcome ${row.status}`}>{loopLabel(row.status)}</span></td><td>{row.score == null ? '—' : `${row.passedChecks}/${row.checks}`}<progress className="history-check-progress" max="1" value={row.score ?? 0} aria-label={`${row.name}: checks passed`}/></td><td>{integer(row.iterations)}</td><td>{elapsed(row.elapsedMs)}</td><td>{integer(row.calls)}</td><td>{integer(row.tokens)}</td><td>{money(row.knownUsd)}{row.unknownCostCalls > 0 && <small className="history-unpriced">+ {row.unknownCostCalls} unpriced</small>}</td></tr>)}
        {!data?.loops?.rows?.length && <tr><td colSpan="8" className="history-empty-cell">No loops in this range.</td></tr>}
      </tbody></table></div></section>
    </> : <>
      <section className="history-stats" aria-label="Global totals">
        <Stat label="Runs" value={integer(totals.runs)} />
        <Stat label="Model calls" value={integer(totals.modelCalls)} detail={`${integer(totals.promptTokens + totals.completionTokens)} total tokens`} />
        <Stat label="Tool calls" value={integer(totals.toolCalls)} />
        <Stat label="Reasoning tokens" value={integer(totals.reasoningTokens)} detail={`${integer(totals.cachedTokens)} cached`} />
        <Stat label="Recorded cost" value={money(totals.costUsd)} detail="provider-reported where available" />
      </section>
      <div className="history-grid">
        <section className="history-card"><header><div><span className="section-label">RESPONSIVENESS</span><h2>First useful signal</h2></div></header><div className="history-latencies">
          <Stat label="First reasoning" value={duration(data?.latency?.timeToFirstReasoningMs)} />
          <Stat label="First visible token" value={duration(data?.latency?.timeToFirstVisibleTokenMs)} />
          <Stat label="First native tool input" value={duration(data?.latency?.timeToFirstNativeToolCallMs)} />
          <Stat label="First workspace effect" value={duration(data?.latency?.timeToFirstWorkspaceEffectMs)} />
          <Stat label="Average total run" value={duration(data?.latency?.totalRunLatencyMs)} />
          <Stat label="Model p95" value={duration(data?.latency?.modelP95Ms)} />
        </div></section>
        <section className="history-card"><header><div><span className="section-label">OUTCOMES</span><h2>Protocol and closure</h2></div></header><div className="history-ratios">
          <Ratio label="Native tool-call rate" value={data?.quality?.nativeToolCallRate} />
          <Ratio label="Schema-valid tools" value={data?.quality?.toolSchemaValidRate} />
          <Ratio label="Verification closure" value={data?.quality?.verificationClosureRate} />
          <Ratio label="First-pass plan valid" value={data?.quality?.firstPassPlanValidRate} />
          <Ratio label="No visible output" value={data?.quality?.noVisibleOutputRate} />
          <Ratio label="Stream idle incidence" value={data?.quality?.streamIdleIncidence} />
          <Ratio label="Approval wait share" value={data?.quality?.approvalWaitShare} />
          <Ratio label="Failed-call recovery" value={data?.quality?.failedCallRecoveryRate} />
          <Ratio label="Repeated tool calls" value={data?.quality?.repeatedToolCallRate} />
          <Ratio label="Unparsed tool dialect" value={data?.quality?.unparsedDialectRate} />
        </div></section>
      </div>
      <section className="history-card history-efficiency-card"><header><div><span className="section-label">EFFICIENCY</span><h2>Cost of accepted outcomes</h2><p>Ratios stay empty until their required recorded outcome exists; estimates remain labeled in the raw trace.</p></div></header><div className="history-efficiency">
        <Stat label="Tokens / accepted plan" value={integer(data?.efficiency?.tokensPerAcceptedPlan)} detail={`${money(data?.efficiency?.costPerAcceptedPlanUsd)} per plan`} />
        <Stat label="Tokens / workspace effect" value={integer(data?.efficiency?.tokensPerSuccessfulToolEffect)} detail={`${money(data?.efficiency?.costPerSuccessfulToolEffectUsd)} per effect`} />
        <Stat label="Tokens / verified completion" value={integer(data?.efficiency?.tokensPerVerifiedCompletion)} detail={`${money(data?.efficiency?.costPerVerifiedCompletionUsd)} per completion`} />
        <Stat label="Calls / workspace effect" value={data?.quality?.callsPerSuccessfulWorkspaceEffect == null ? '—' : Number(data.quality.callsPerSuccessfulWorkspaceEffect).toFixed(2)} />
        <Stat label="Planner diagnostics" value={integer(data?.planner?.diagnosticEvents)} detail={`${integer(data?.planner?.rejectedPlans)} rejected plans`} />
        <Stat label="Repairs / accepted plan" value={data?.planner?.repairsPerAcceptedPlan == null ? '—' : Number(data.planner.repairsPerAcceptedPlan).toFixed(2)} detail={`${integer(data?.efficiency?.verifiedCompletions)} verified completions`} />
      </div></section>
      <section className="history-card history-table-card"><header><div><span className="section-label">COMPARISON</span><h2>Models</h2><p>Reasoning share is descriptive. High share followed by a verified result is not treated as a failure.</p></div></header>
        <div className="history-table-wrap"><table><thead><tr><th>Model</th><th>Calls</th><th>Success</th><th>Reasoning share</th><th>No visible output</th><th>Median</th><th>P95</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
          {data?.models?.map(row => <tr key={row.model}><td>{row.model}</td><td>{integer(row.calls)}</td><td>{pct(row.successRate)}</td><td>{pct(row.reasoningTokenShare)}</td><td>{pct(row.noVisibleOutputRate)}</td><td>{duration(row.medianLatencyMs)}</td><td>{duration(row.p95LatencyMs)}</td><td>{integer(row.promptTokens + row.completionTokens)}</td><td>{money(row.costUsd)}</td></tr>)}
          {!data?.models?.length && <tr><td colSpan="9" className="history-empty-cell">No model results in this range.</td></tr>}
        </tbody></table></div>
        <details className="history-comparison-detail"><summary>Show workflow · version · preset · task class · outcome groups</summary><div className="history-table-wrap"><table><thead><tr><th>Workflow</th><th>Version</th><th>Preset</th><th>Task class</th><th>Model</th><th>Outcome</th><th>Calls</th><th>Reasoning share</th><th>Median</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
          {data?.comparisons?.map((row, index) => <tr key={`${row.workflow}:${row.preset}:${row.taskClass}:${row.model}:${row.outcome}:${index}`}><td>{row.workflow}</td><td>{row.workflowVersion}</td><td>{row.preset}</td><td>{row.taskClass}</td><td>{row.model}</td><td>{row.outcome}</td><td>{integer(row.calls)}</td><td>{pct(row.reasoningTokenShare)}</td><td>{duration(row.medianLatencyMs)}</td><td>{integer(row.promptTokens + row.completionTokens)}</td><td>{money(row.costUsd)}</td></tr>)}
        </tbody></table></div></details>
      </section>
      <section className="history-card history-table-card"><header><div><span className="section-label">RUNS</span><h2>Technical traces</h2></div></header>
        <div className="history-table-wrap"><table><thead><tr><th>Started</th><th>Run</th><th>Status</th><th>Model calls</th><th>Tools</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>
          {data?.runs?.map(run => <tr key={run.runId} className="history-run-row" onClick={() => openTrace(run)}><td>{new Date(run.at).toLocaleString()}</td><td className="mono">{short(run.runId)}</td><td>{run.status}</td><td>{integer(run.modelCalls)}</td><td>{integer(run.toolCalls)}</td><td>{integer(run.tokens)}</td><td>{money(run.costUsd)}</td></tr>)}
          {!data?.runs?.length && <tr><td colSpan="7" className="history-empty-cell">New runs will appear here as immutable events arrive.</td></tr>}
        </tbody></table></div>
      </section>
    </>}
    {selected && <TraceTimeline run={selected} events={trace} busy={traceBusy} onClose={() => { traceRequest.current++; setSelected(null); setTrace([]); }} />}
  </div>;
}
