import React from 'react';
import { campaignDefaults, campaignForecast } from '../../core/campaignPolicy.js';

export function CampaignReview({ definition, goal }) {
  const p = definition.campaign, forecast = goal?.campaign?.forecast ?? campaignForecast(definition);
  if (!p || p.mode === 'acceptance') return <p>This Goal runs on this computer. Keep the app open and the computer awake; shutdown pauses saved work.</p>;
  return <section aria-label="Campaign review"><p>{p.mode === 'optimize' ? 'Optimize within the agreed budget' : 'Stop after a verified improvement'} · up to {p.maxCandidates} distinct candidates in {p.families.length} strategy families. At least {p.minExploration} distinct candidates before an early search stop.</p>
    <p>Screen {Math.min(p.screenCases, definition.evaluation.suite.cases.filter(c => c.split === 'development').length)} development cases once; deepen up to {p.survivors} survivors; confirm up to {p.finalists} finalists against interleaved baseline trials with at least {p.confirmationRepeats} repetitions per case. {definition.evaluation.finalVerification.required ? 'Freeze one candidate for the reserved final test.' : 'Independent final verification is not required by this policy.'}</p>
    <p>Optimizer and candidate model: {definition.worker?.model}. Judge models: {[...new Set([...definition.evaluation.suite.evaluators, ...definition.evaluation.suite.cases.flatMap(c => c.evaluators ?? [])].filter(e => ['ai-rubric', 'reference'].includes(e.id)).map(e => e.config.model))].join(', ') || 'No model judge configured'}.</p>
    {forecast && <p>{forecast.trials.toLocaleString()} planned trials · approximately {forecast.callsRange.map(x => x.toLocaleString()).join('–')} API calls ({forecast.source}).{forecast.usdRange && ` Estimated cost $${forecast.usdRange.map(x => x.toFixed(2)).join('–$')}.`}{forecast.tokensRange && ` Approximately ${forecast.tokensRange.map(x => Math.round(x).toLocaleString()).join('–')} tokens.`}{forecast.minutesRange && ` ${forecast.minutesRange.map(x => Math.ceil(x)).join('–')} minutes.`}{forecast.exceedsCalls && ' The forecast exceeds the call allowance; search will stop early to protect confirmation.'}</p>}
    <p>{p.concurrency} concurrent trials · {p.repairCalls} evaluator repair calls · {p.reserveCalls} calls and ${p.reserveUsd} protected for confirmation. Each call reserves an estimated ${p.estimatedCallUsd}. {p.unknownPricing === 'pause' ? 'Unknown pricing pauses for review.' : 'Unpriced attempts retain their estimated reservation.'} Estimates are not a provider billing guarantee.</p>
    <p>Runs on this computer while the app is open and the computer is awake. Shutdown pauses saved work. Successful and failed development experiments remain available to compatible campaigns. Validation and final-test evidence stay outside optimizer memory.</p>
    {goal?.pricingPause && <p role="alert">{goal.pricingPause}</p>}
  </section>;
}

export function CampaignProgress({ goal, onInspect }) {
  const c = goal.campaign;
  if (!c) return null;
  return <section aria-label="Campaign progress"><h3>Campaign · {c.phase}</h3><p>{c.candidateCount} / {goal.contract.campaign.maxCandidates} distinct candidates · {goal.iteration} proposals · {Object.keys(c.families).length} families explored · {new Set(c.population.map(x => x.family)).size} surviving families · {c.population.length} quality/cost tradeoffs</p>
    <p>{Object.values(goal.activeTrials ?? {}).length} active trials · {c.validationUsed?.length ?? 0} validation queries · {c.retestsUsed} deliberate repeats · ${Number(goal.reservedUsd ?? 0).toFixed(4)} reserved or unpriced estimates</p>
    {c.result && <p>{c.result.reason}</p>}
    <div className="goal-actions"><button disabled={!c.forecast} onClick={() => onInspect('campaign-pilot')}>Calibration forecast</button>{c.result && <button onClick={() => onInspect('campaign-result')}>Confirmed result</button>}</div>
  </section>;
}

const NUMBER = (key, label, min, max, hint) => ({ key, label, min, max, hint });
const GROUPS = limits => [
  ['Search space', [NUMBER('maxCandidates', 'Distinct candidate ceiling', 1, limits.iterations), NUMBER('minExploration', 'Minimum exploration', 1, null, 'Distinct candidates before an early stop is allowed.')]],
  ['Evaluation depth', [NUMBER('screenCases', 'Screening cases', 1, 30), NUMBER('survivors', 'Deep evaluations', 1, 1000), NUMBER('finalists', 'Finalists', 1, 10), NUMBER('confirmationRepeats', 'Matched repetitions', 2, 20), NUMBER('validationQueries', 'Validation query allowance', 0, 10), NUMBER('retests', 'Intentional repeat allowance', 0, 1000)]],
  ['Concurrency and reserves', [NUMBER('concurrency', 'Concurrent trials', 1, 4), NUMBER('repairCalls', 'Evaluator repair calls', 0, limits.calls), NUMBER('reserveCalls', 'Confirmation call reserve', 1, limits.calls - 1)]]
];

// `frame` is "details" for the collapsible the sidebar used to hold, or
// "section" when the configure panel already gives it a page of its own.
export default function CampaignDesign({ value, limits, disabled, onChange, frame = 'details' }) {
  const p = value, change = patch => onChange({ ...p, ...patch });
  const numberField = ({ key, label, min, max, hint }) => <label className="goal-field" key={key}>{label}<input aria-label={label} type="number" min={min} max={key === 'minExploration' ? p.maxCandidates : max} disabled={disabled} value={p[key]} onChange={event => change({ [key]: Number(event.target.value) })}/>{hint && <small className="goal-field-hint">{hint}</small>}</label>;
  const body = <>
    <label className="goal-field">Completion policy<select aria-label="Completion policy" disabled={disabled} value={p?.mode ?? 'acceptance'} onChange={event => onChange(event.target.value === 'acceptance' ? null : { ...campaignDefaults(Math.min(200, limits.iterations)), reserveCalls: Math.min(100, Math.max(1, Math.floor(limits.calls / 4))), repairCalls: Math.min(20, limits.calls), ...p, mode: event.target.value })}>
      <option value="acceptance">Satisfy acceptance criteria</option><option value="optimize">Optimize within a budget</option><option value="improve">Stop after verified improvement</option>
    </select><small className="goal-field-hint">{p ? 'A campaign needs a fixed baseline and versioned evaluation. It can finish with no improvement and retain the baseline. Development, validation and final-test cases are set in Evaluation.' : 'The loop stops as soon as a result passes every check.'}</small></label>
    {p && <>
      {GROUPS(limits).map(([title, fields]) => <React.Fragment key={title}><h4 className="goal-subhead">{title}</h4><div className="goal-field-row">{fields.map(numberField)}</div>
        {title === 'Search space' && <>
          <label className="goal-field">Strategy families<input aria-label="Strategy families" disabled={disabled} value={p.families.join(', ')} onChange={event => change({ families: event.target.value.split(',').map(x => x.trim()).filter(Boolean) })}/><small className="goal-field-hint">Comma-separated. Each candidate is assigned one family to explore.</small></label>
          <fieldset><legend>Allowed changes</legend>{[['prompt', 'Prompt changes'], ['settings', 'Worker settings'], ['structure', 'Workflow structure']].map(([key, label]) => <label key={key} className="goal-check"><input type="checkbox" disabled={disabled} checked={p.allowedChanges.includes(key)} onChange={event => change({ allowedChanges: event.target.checked ? [...p.allowedChanges, key] : p.allowedChanges.filter(x => x !== key) })}/>{label}</label>)}</fieldset>
        </>}
        {title === 'Concurrency and reserves' && <>
          <div className="goal-field-row">{[['reserveUsd', 'Confirmation dollar reserve'], ['estimatedCallUsd', 'Estimated reservation per call']].map(([key, label]) => <label className="goal-field" key={key}>{label}<input aria-label={label} type="number" min="0" step="any" disabled={disabled} value={p[key]} onChange={event => change({ [key]: Number(event.target.value) })}/></label>)}</div>
          <label className="goal-field">Unknown pricing<select aria-label="Unknown pricing" disabled={disabled} value={p.unknownPricing} onChange={event => change({ unknownPricing: event.target.value })}><option value="pause">Pause for review</option><option value="reserve">Retain estimated reservation</option></select></label>
          <label className="goal-check"><input type="checkbox" disabled={disabled} checked={p.reuseLearning} onChange={event => change({ reuseLearning: event.target.checked })}/>Retrieve learning from compatible campaigns</label>
        </>}
      </React.Fragment>)}
    </>}
  </>;
  return frame === 'section' ? <div className="campaign-design">{body}</div> : <details open={Boolean(p)}><summary>Search and completion</summary>{body}</details>;
}
