import React, { useEffect, useState } from 'react';
const show = value => value == null ? 'Unknown' : Number.isInteger(value) ? String(value) : value.toFixed(3);
const promptDiff = (before, after) => {
  const a = before.split('\n'), b = after.split('\n');
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [...a.slice(0, start).map(line => `  ${line}`), ...a.slice(start, a.length - end).map(line => `− ${line}`), ...b.slice(start, b.length - end).map(line => `+ ${line}`), ...a.slice(a.length - end).map(line => `  ${line}`)].join('\n');
};
const download = (name, value) => { const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
export default function EvaluationResults({ projectId, goal, metrics }) {
  const [selected, setSelected] = useState(null), [record, setRecord] = useState(null), [report, setReport] = useState(null), [error, setError] = useState('');
  const current = goal.history.find(h => h.iteration === selected) ?? goal.best ?? goal.bestPartial ?? goal.current;
  const invoke = (action, args) => window.flyt.goal(action, { projectId, goalId: goal.id, ...args });
  useEffect(() => { let live = true; setRecord(null); setReport(null); if (current) invoke('inspect', { record: current.artifact }).then(r => live && setRecord(r)).catch(e => live && setError(e.message)); return () => { live = false; }; }, [current?.artifact, goal.id]);
  const inspect = name => invoke('inspect', { record: name }).then(setReport).catch(e => setError(e.message));
  const evaluation = record?.evaluation, primary = goal.contract.evaluation.ranking.primary;
  const baseline = [...(goal.baselines ?? []), ...(goal.baseline ? [goal.baseline] : [])].find(item => item.benchmarkVersion === evaluation?.benchmarkVersion);
  return <section className="loop-result evaluation-results" aria-label="Evaluation experiments">
    <header><h2>{goal.name}</h2><p role="status">{goal.status} · {goal.reason}</p></header>{metrics}
    {error && <p role="alert">{error}</p>}
    {goal.evaluationInterruption && <p>Interrupted evaluation: {goal.evaluationInterruption.reason} <button onClick={() => inspect(goal.evaluationInterruption.record)}>Inspect interruption</button></p>}
    <p><strong>{goal.best ? `Best eligible: iteration ${goal.best.iteration}` : goal.bestPartial ? `Best partial: iteration ${goal.bestPartial.iteration} — not verified success` : 'No eligible candidate yet'}</strong></p>
    <p>Current: {goal.current?.iteration ?? '—'} · Active benchmark v{goal.benchmark.version}</p>
    <p>Baseline under selected attempt’s benchmark: {show(baseline?.metrics[primary]?.value)} {primary}{!baseline && ' · no matching measurement available'}</p>
    <p>{goal.holdout?.exposed ? 'Exposed holdout: a fresh verification set is required for an independent claim.' : 'Held-out evidence is excluded from optimizer feedback.'}</p>
    <div className="evaluation-table-wrap"><table><caption>Experiments · development measurements</caption><thead><tr><th>Attempt</th><th>Gates</th><th>{primary}</th><th>Trials</th><th>Errors</th><th>Repairs / fallback</th><th>Version</th></tr></thead><tbody>{goal.history.map(h => <tr key={h.iteration}><td><button aria-pressed={current?.iteration === h.iteration} onClick={() => setSelected(h.iteration)}>Iteration {h.iteration}</button></td><td>{h.eligible ? 'Eligible' : h.evaluation?.comparable ? 'Rejected' : 'Incomplete evidence'}</td><td>{show(h.evaluation?.metrics[primary]?.value)}</td><td>{h.evaluation?.counts.scheduled}</td><td>{h.evaluation?.counts.errors}</td><td>{h.evaluation?.counts.repairs} / {h.evaluation?.counts.fallbacks}</td><td>{h.evaluation?.suiteVersion}</td></tr>)}</tbody></table></div>
    {evaluation && <section><h3>Iteration {current.iteration} · {evaluation.eligible ? 'Eligible' : 'Not eligible'}</h3>
      <p>{evaluation.rejection ?? (!evaluation.eligible ? 'A headline metric cannot compensate for failed or incomplete required gates.' : 'Eligibility and target achievement are separate decisions.')}</p>
      <p>First-attempt contract rate: {show(evaluation.firstAttemptRate)} ({evaluation.counts.firstSuccess}/{evaluation.counts.attempted} attempted). Recovered: {show(evaluation.recoveryRate)}. Unresolved: {show(evaluation.unresolvedRate)}.</p>
      <p>{evaluation.scope}</p><p>Target / final verification: {record.achieved ? 'Passed' : record.finalVerification?.reason ?? (record.finalVerification ? 'Not passed' : 'Not established')}</p>
      <p>Change rationale: {record.findings?.map(finding => finding.text ?? finding).join(' · ') || 'No rationale recorded'}</p>
      <p>Owner usage through this commitment: {show(record.calls)} calls · ${show(record.knownUsd)} known cost. Includes candidate generation, verification and any reference transition.</p>
      <div className="evaluation-table-wrap"><table><caption>Named metrics</caption><thead><tr><th>Metric</th><th>Value</th><th>Unit</th><th>Samples</th></tr></thead><tbody>{Object.entries(evaluation.metrics).map(([key, m]) => <tr key={key}><th>{key}</th><td>{show(m.value)}</td><td>{m.unit}</td><td>{m.samples}</td></tr>)}</tbody></table></div>
      <details><summary>Candidate artifact / prompt and baseline</summary><h4>Candidate</h4><pre>{record.candidate.text}</pre><h4>Baseline</h4><pre>{goal.contract.evaluation.baseline?.text ?? 'No baseline supplied'}</pre>{goal.contract.evaluation.baseline && <><h4>Prompt / artifact changes (− removed, + added)</h4><pre>{promptDiff(goal.contract.evaluation.baseline.text, record.candidate.text)}</pre></>}<button onClick={() => download(`candidate-${current.iteration}.txt`, record.candidate.text)}>Export artifact</button></details>
      <details open><summary>Cases and evidence</summary>{evaluation.reportIds.map(name => <p key={name}><button onClick={() => inspect(name)}>{name.replace(/^report-evaluation-/, '')}</button></p>)}{record.finalVerification?.reportIds?.map(name => <p key={name}><button onClick={() => inspect(name)}>Final verification · {name}</button></p>)}</details>
      <button onClick={() => download('evaluation-report.json', record)}>Export evaluation report</button>
    </section>}
    <section><h3>References</h3><p>Policy: {goal.contract.evaluation.promotion.mode} · limit {goal.contract.evaluation.promotion.limit}</p>
      {(goal.pendingPromotion || goal.referenceProposal) && <><p>{(goal.pendingPromotion || goal.referenceProposal).status} · {(goal.pendingPromotion || goal.referenceProposal).reason ?? 'Fixed verification evidence retained'}</p><button onClick={() => inspect((goal.pendingPromotion || goal.referenceProposal).record)}>Inspect reference proposal</button></>}
      {goal.pendingPromotion?.verified && goal.pendingPromotion.authorization === 'manual' && !goal.live && <div className="goal-actions">{['approve', 'reject'].map(decision => <button key={decision} onClick={() => invoke('reference-review', { baseRevision: goal.referenceRevision, decision }).catch(e => setError(e.message))}>{decision === 'approve' ? 'Approve verified reference' : 'Reject reference'}</button>)}</div>}
      {goal.promotions.map(p => <p key={p.id}>{p.status} · v{p.from} → v{p.to} <button onClick={() => inspect(`transition-${p.id}`)}>Inspect transition</button>{!goal.live && <button onClick={() => invoke('reference-review', { baseRevision: goal.referenceRevision, decision: 'restore', version: p.from }).catch(e => setError(e.message))}>Restore v{p.from}</button>}</p>)}
      <button onClick={() => download('benchmark.json', goal.benchmark)}>Export benchmark</button>
    </section>
    {report && <section aria-label="Evaluation evidence"><h3>Evidence</h3>{report.evidence?.input && <><h4>Case input</h4><pre>{report.evidence.input}</pre></>}{report.artifact && <><p>Case {report.caseId} · {report.artifact.channel ?? 'text'} channel</p><pre>{report.artifact.text}</pre></>}{report.checks && <ul>{report.checks.map(c => <li key={c.name}>{c.mandatory ? 'Required' : 'Optional'} · {c.name}: {c.status} · {c.code}<p>{c.explanation}</p></li>)}</ul>}<details open><summary>Versioned report, diagnostics and comparison evidence</summary><pre>{JSON.stringify(report, null, 2)}</pre></details></section>}
  </section>;
}
