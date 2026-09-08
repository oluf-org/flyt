import React, { useEffect, useState } from 'react';
import MarkdownView from '../MarkdownView.jsx';
import { loopSummary } from '../../core/loopStatistics.js';
import { count, cost, elapsed, loopLabel } from '../activityFormat.js';
import ActivityIcon from '../ActivityIcon.jsx';
import './loopResultStyles.css';

export function LoopMetrics({ stats }) {
  return <dl className="loop-metrics" aria-label="Loop statistics">
    <div><dt>Iterations</dt><dd>{count(stats.iterations)}<small> / {count(stats.limits?.iterations)}</small></dd></div>
    <div><dt>Active time</dt><dd>{elapsed(stats.elapsedMs)}</dd></div>
    <div><dt>Model calls</dt><dd>{count(stats.calls)}</dd></div>
    <div title={stats.tokens == null ? 'Token usage was not recorded' : `${count(stats.promptTokens)} input · ${count(stats.completionTokens)} output`}><dt>Tokens</dt><dd>{count(stats.tokens)}</dd></div>
    <div><dt>Known cost</dt><dd>{cost(stats.knownUsd)}</dd>{stats.unknownCostCalls > 0 && <small>{count(stats.unknownCostCalls)} unpriced</small>}</div>
  </dl>;
}

export default function LoopResult({ projectId, goal, onOpenRun }) {
  const [stats, setStats] = useState(null), [selected, setSelected] = useState(null), [record, setRecord] = useState(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    window.flyt.goal('stats', { projectId, goalId: goal.id }).then(value => { if (live) { setStats(value); setError(''); } })
      .catch(caught => live && setError(String(caught.message ?? caught)));
    return () => { live = false; };
  }, [projectId, goal.id, goal.updatedAt, revision]);
  const data = stats?.id === goal.id ? { ...stats, ...loopSummary(goal, stats) } : loopSummary(goal);
  const history = stats?.id === goal.id ? stats.history : goal.history;
  const current = history?.find(item => item.iteration === selected) ?? history?.find(item => item.iteration === goal.best?.iteration) ?? history?.at(-1);
  useEffect(() => {
    let live = true;
    setRecord(null); setLoading(Boolean(current));
    if (current) window.flyt.goal('inspect', { projectId, goalId: goal.id, record: current.artifact })
      .then(value => { if (live) setRecord(value); }).catch(caught => live && setError(String(caught.message ?? caught)))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [projectId, goal.id, current?.artifact, revision]);
  return <section className="loop-result" aria-label="Loop result">
    <header className="loop-result-head"><ActivityIcon kind="loop" id={goal.id} size={32}/><div><h2>{loopLabel(goal.status)}</h2><p>{goal.reason}</p></div>
      {data.score != null && <div className="loop-check-ring" style={{ '--score': `${data.score * 100}%` }} title="Best checks passed"><strong>{data.passedChecks}<small>/{data.checks}</small></strong><span>checks</span></div>}</header>
    <LoopMetrics stats={data}/>
    {error && <p role="alert" className="loop-result-error">{error} <button onClick={() => setRevision(value => value + 1)}>Retry</button></p>}
    {history?.length > 0 && <section className="loop-iterations" aria-label="Iteration progress"><header><h3>Checks passed</h3><span>{history.length} iterations</span></header>
      <div className="loop-score-chart">{history.map(item => <button key={item.iteration} className={current?.iteration === item.iteration ? 'selected' : ''}
        aria-label={`Iteration ${item.iteration}: ${Math.round(item.score * 100)}% checks passed`} aria-pressed={current?.iteration === item.iteration} onClick={() => setSelected(item.iteration)}>
        <strong>{Math.round(item.score * 100)}%</strong><span className="loop-score-track"><i style={{ height: `${Math.max(2, item.score * 100)}%` }}/></span><small>{item.iteration}</small>
      </button>)}</div></section>}
    {current && <section className="loop-candidate"><header><h3>Iteration {current.iteration}{goal.best?.iteration === current.iteration && <span className="loop-best">Best</span>}</h3>
      <button onClick={() => onOpenRun?.(current.runId)}>Open workflow ↗</button></header>
      {loading ? <p role="status">Loading result…</p> : record && <>
        <ul className="loop-checks" aria-label="Acceptance checks">{record.checks?.map(check => <li key={check.index} className={check.passed ? 'passed' : 'missed'}>
          <span aria-label={check.passed ? 'Passed' : 'Not passed'}>{check.passed ? '✓' : '−'}</span><span>{goal.contract.criteria[check.index]?.value ?? `Check ${check.index + 1}`}{check.reason && <small>{check.reason}</small>}</span></li>)}
          {record.tests?.map((test, index) => <li key={`test-${index}`} className={test.passed ? 'passed' : 'missed'}><span aria-label={test.passed ? 'Passed' : 'Not passed'}>{test.passed ? '✓' : '−'}</span><span>{test.input}</span></li>)}</ul>
        <div className="loop-candidate-text"><MarkdownView text={record.candidate?.text ?? ''}/></div>
      </>}
    </section>}
    <details className="loop-usage-detail"><summary>Usage details</summary><dl><dt>Input tokens</dt><dd>{count(data.promptTokens)}</dd><dt>Output tokens</dt><dd>{count(data.completionTokens)}</dd><dt>Reasoning tokens</dt><dd>{count(data.reasoningTokens)}</dd><dt>Cached tokens</dt><dd>{count(data.cachedTokens)}</dd><dt>Tool calls</dt><dd>{count(data.toolCalls)}</dd><dt>Model</dt><dd>{data.model ?? '—'}</dd></dl></details>
  </section>;
}
