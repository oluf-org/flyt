import React, { useEffect, useState } from 'react';

export const defaultEvaluation = () => ({ version: 1, target: 'artifact', suite: { id: 'my-benchmark', version: 1, name: 'My benchmark',
  evaluators: [{ id: 'json-schema', version: 1, name: 'schema', mandatory: true, config: { schema: { type: 'object' }, raw: true } }],
  cases: [{ id: 'case-1', input: 'Return the requested structured result.', split: 'development', repeats: 1, references: [] }] },
  ranking: { primary: 'gateRate', minImprovement: 0, tieBreakers: [] }, finalVerification: { required: false }, promotion: { mode: 'off', limit: 1, confirmation: 'fresh-evaluation' } });

const SPLIT_LABEL = { development: 'development', validation: 'validation', 'held-out': 'held-out' };

function JsonEditor({ label, value, onChange, disabled, rows = 5, hint }) {
  const [text, setText] = useState(JSON.stringify(value, null, 2)), [error, setError] = useState('');
  useEffect(() => setText(JSON.stringify(value, null, 2)), [JSON.stringify(value)]);
  return <label className="goal-field">{label}<textarea aria-label={label} rows={rows} disabled={disabled} value={text} onChange={event => { const raw = event.target.value; setText(raw); try { onChange(JSON.parse(raw)); setError(''); } catch { setError('Enter valid JSON before saving.'); } }} aria-invalid={!!error}/>{hint && <small className="goal-field-hint">{hint}</small>}{error && <small role="alert">{error}</small>}</label>;
}
function editablePolicy(value) {
  if (!value || !value.suite || !Array.isArray(value.suite.cases) || !Array.isArray(value.suite.evaluators)
    || !value.ranking || !value.finalVerification || !value.promotion || typeof value.target !== 'string'
    || value.suite.cases.some(item => !item || typeof item.id !== 'string' || typeof item.input !== 'string' || (item.references != null && (!Array.isArray(item.references) || item.references.some(ref => !ref || typeof ref.text !== 'string'))))) throw new Error('Invalid editable evaluation structure');
  return value;
}
// `frame` is "details" for the collapsible the sidebar used to hold, or
// "section" when the configure panel already gives it a page of its own.
export default function EvaluationDesign({ value, onChange, disabled, onQuote, projectId, frame = 'details' }) {
  const [benchmarks, setBenchmarks] = useState([]), [storageError, setStorageError] = useState('');
  useEffect(() => { let live = true; if (projectId) window.flyt.goal('benchmark-list', { projectId }).then(items => live && setBenchmarks(items)).catch(error => live && setStorageError(error.message)); return () => { live = false; }; }, [projectId]);
  const accept = next => onChange(editablePolicy(next));
  const e = value, change = patch => accept({ ...e, ...patch }), suite = patch => change({ suite: { ...e.suite, ...patch } });
  const saveBenchmark = async () => {
    try {
      const baseVersion = Math.max(0, ...benchmarks.filter(item => item.id === e.suite.id).map(item => item.version));
      const { digest, ...saved } = await window.flyt.goal('benchmark-save', { projectId, baseVersion, suite: { ...e.suite, version: baseVersion + 1 } });
      setBenchmarks([...benchmarks, saved]); change({ suite: saved }); setStorageError('');
    } catch (error) { setStorageError(error.message); }
  };
  const body = <>
    <label className="goal-check"><input type="checkbox" checked={Boolean(e)} disabled={disabled} onChange={event => onChange(event.target.checked ? defaultEvaluation() : null)}/>Use versioned evaluation<small>{e ? 'Runtime-owned work after every candidate. Mandatory gates cannot be removed by editing the loop.' : 'Saved Goals without a benchmark retain legacy containment scoring.'}</small></label>
    {e && <>
      <h4 className="goal-subhead">Target</h4>
      <label className="goal-field">Artifact or block being improved<select aria-label="Evaluation target" disabled={disabled} value={e.target} onChange={event => change({ target: event.target.value })}><option value="artifact">Artifact / answer</option><option value="plan">Plan prompt</option><option value="task-graph">Plan &amp; dispatch prompt (planner only)</option><option value="workflow">Workflow source</option></select>
        {e.target !== 'artifact' && <small className="goal-field-hint">{e.target === 'task-graph' ? 'Prompt supplements invariant production guidance. No workers are launched.' : e.target === 'plan' ? 'Prompt replaces standing guidance; the production array contract remains.' : 'The saved candidate workflow runs on clean fixed case inputs.'}</small>}</label>
      {['plan', 'task-graph'].includes(e.target) && <button type="button" disabled={disabled} onClick={() => suite({ evaluators: [{ id: 'block-contract', version: 1, name: 'contract', mandatory: true, config: { block: e.target } }, ...e.suite.evaluators.filter(x => x.name !== 'contract')] })}>Satisfies block contract</button>}

      <h4 className="goal-subhead">Benchmark</h4>
      <label className="goal-field">Benchmark name<input disabled={disabled} value={e.suite.name} onChange={event => suite({ name: event.target.value })}/><small className="goal-field-hint">Suite {e.suite.id} · version {e.suite.version}</small></label>
      {projectId && <div className="goal-field-row"><label className="goal-field">Load project benchmark<select aria-label="Load project benchmark" disabled={disabled} value="" onChange={event => { const { digest, ...saved } = benchmarks.find(item => `${item.id}@${item.version}` === event.target.value); change({ suite: saved }); }}><option value="" disabled>Select an immutable version…</option>{benchmarks.map(item => <option key={`${item.id}@${item.version}`} value={`${item.id}@${item.version}`}>{item.name} · v{item.version}</option>)}</select></label><div className="goal-field align-end"><button type="button" disabled={disabled} onClick={saveBenchmark}>Save benchmark version</button></div></div>}
      {storageError && <p role="alert" className="goal-field-warning">{storageError}</p>}

      <h4 className="goal-subhead">Cases <span className="goal-subhead-count">{e.suite.cases.length}</span></h4>
      {e.suite.cases.map((c, index) => { const update = patch => suite({ cases: e.suite.cases.map((item, i) => i === index ? { ...item, ...patch } : item) }); return <details className="goal-case" key={index} open={index === 0 || e.suite.cases.length <= 3}><summary>{c.id}<small>{SPLIT_LABEL[c.split] ?? c.split} · {c.repeats}× · {(c.references ?? []).length} refs</small></summary>
        <label className="goal-field">Input<textarea aria-label={`Input for ${c.id}`} disabled={disabled} value={c.input} onChange={event => update({ input: event.target.value })}/></label>
        <div className="goal-field-row"><label className="goal-field">Split<select aria-label={`Split for ${c.id}`} disabled={disabled} value={c.split} onChange={event => update({ split: event.target.value })}><option value="development">Development</option><option value="validation">Restricted validation</option><option value="held-out">Final test (held-out)</option></select></label><label className="goal-field">Repeats<input aria-label={`Repeats for ${c.id}`} disabled={disabled} type="number" min="1" max="20" value={c.repeats} onChange={event => update({ repeats: Number(event.target.value) })}/></label></div>
        <details><summary>References, provenance and requirements</summary><label className="goal-field">Case requirements<textarea disabled={disabled} value={c.requirements ?? ''} onChange={event => update({ requirements: event.target.value })}/></label>
          <JsonEditor label={`References for ${c.id}`} disabled={disabled} value={c.references ?? []} onChange={references => update({ references })}/>
          {(c.references ?? []).map((ref, i) => <details key={i}><summary>Reference {i + 1} · {ref.reviewed ? 'Human reviewed' : 'Not human reviewed'}</summary><pre>{ref.text}</pre><p>{ref.limitations || 'No limitations recorded'}</p><pre>{JSON.stringify(ref.provenance ?? {}, null, 2)}</pre></details>)}
        </details>
        <div className="goal-actions"><button type="button" disabled={disabled || e.suite.cases.length <= 1} onClick={() => suite({ cases: e.suite.cases.filter((_, i) => i !== index) })}>Remove case</button></div></details>; })}
      <button type="button" disabled={disabled || e.suite.cases.length >= 30} onClick={() => suite({ cases: [...e.suite.cases, { id: `case-${e.suite.cases.length + 1}`, input: 'New case', split: 'development', repeats: 1 }] })}>Add case</button>

      <h4 className="goal-subhead">Verification</h4>
      <label className="goal-check"><input type="checkbox" disabled={disabled} checked={e.finalVerification.required} onChange={event => change({ finalVerification: { required: event.target.checked } })}/>Require independent final verification</label>
      <div className="goal-field-row">
        <label className="goal-field">Reference promotion<select aria-label="Reference promotion policy" disabled={disabled} value={e.promotion.mode} onChange={event => change({ promotion: { ...e.promotion, mode: event.target.value } })}><option value="off">Keep fixed reference</option><option value="automatic">Automatic when fixed rules pass</option><option value="manual">Verified proposal with manual review</option></select></label>
        <label className="goal-field">Promotion limit<input type="number" min="0" max="5" disabled={disabled} value={e.promotion.limit} onChange={event => change({ promotion: { ...e.promotion, limit: Number(event.target.value) } })}/></label>
      </div>
      {e.promotion.mode !== 'off' && <p className="goal-hint">Required: passing mandatory gates, named meaningful gain, no mandatory regression, agreement in both blinded orders, fresh confirmation, then baseline and leader re-evaluation. Promotion never installs production prompts.</p>}

      <details><summary>Advanced · evaluators, ranking, baseline</summary>
        <JsonEditor label="Typed evaluators and mandatory gates" disabled={disabled} value={e.suite.evaluators} onChange={evaluators => suite({ evaluators })} hint="Types: contains, text-limits, json-schema, block-contract, field, command, runtime, ai-rubric, reference. Use text-limits for word/character ceilings and forbidden content, and typed field checks for units and values. Judge findings are subjective; configure the judge model and rubric independently."/>
        <JsonEditor label="Ranking and meaningful improvement" disabled={disabled} value={e.ranking} onChange={ranking => change({ ranking })} rows={3}/>
        <JsonEditor label="Fixed baseline artifact or prompt" disabled={disabled} value={e.baseline ?? null} onChange={baseline => { const next = { ...e }; if (baseline) next.baseline = baseline; else delete next.baseline; onChange(next); }} rows={3}/>
      </details>
      <details><summary>Import / export complete policy</summary><JsonEditor label="Evaluation policy JSON" value={e} onChange={accept} disabled={disabled} rows={12} hint="Copy this definition to reuse immutable cases and references. Runtime progress and verification never transfer."/></details>
      {onQuote && !disabled && <div className="goal-actions"><button type="button" onClick={() => onQuote('goal/evaluation', e)}>Ask AI to change evaluation…</button></div>}
    </>}
  </>;
  return frame === 'section' ? <div className="evaluation-design">{body}</div> : <details className="evaluation-design" open={Boolean(e)}><summary>Evaluation</summary>{body}</details>;
}
