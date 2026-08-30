import React, { useEffect, useMemo, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import { runView } from './runView.js';
import { traceView, duration } from './traceView.js';
import { workflowBlockNodes } from './workflowTree.js';
import './workStyles.css';

function Interaction({ interaction, onDecide, onAnswer }) {
  const [answer, setAnswer] = useState('');
  if (!interaction) return null;
  if (interaction.kind === 'approval') return <section className="work-interaction approval" aria-live="assertive">
    <span className="section-label">Approval required · {interaction.blockId}</span><h3>{interaction.tool} wants to run</h3>
    <p>{interaction.reason}</p><pre>{JSON.stringify(interaction.args ?? {}, null, 2)}</pre><div>
      <button className="work-allow" onClick={() => onDecide?.(true)}>Approve</button><button onClick={() => onDecide?.(false)}>Refuse</button>
    </div></section>;
  return <section className="work-interaction question" aria-live="assertive"><span className="section-label">Question · {interaction.blockId}</span>
    <h3>{interaction.question}</h3>{interaction.context && <p>{interaction.context}</p>}{interaction.options?.length > 0 && <div className="work-options">
      {interaction.options.map(option => <button key={option} onClick={() => onAnswer?.(option)}>{option}</button>)}</div>}
    <textarea rows="3" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="Answer this block directly" />
    <button className="work-allow" disabled={!answer.trim()} onClick={() => onAnswer?.(answer)}>Send answer to block</button></section>;
}

function RunRail({ stack, view }) {
  return <aside className="work-run-rail" aria-label="Run progress"><span className="section-label">Run</span>
    {workflowBlockNodes(stack.root).map((node, index) => { const status = view.blocks[node.id]?.status ?? 'pending'; return <div key={node.id} className={`work-rail-step state-${status}`}>
      <span className="work-rail-index">{status === 'done' ? '✓' : status === 'failed' ? '!' : index + 1}</span><span><strong>{node.title ?? node.id}</strong><small>{status}</small></span></div>; })}
  </aside>;
}

function QueryPre({ value }) {
  return <pre className="work-query-pre">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

function QueryEntry({ entry, isLatest = false }) {
  const [open, setOpen] = useState(isLatest);
  useEffect(() => { if (!isLatest) setOpen(false); }, [isLatest]);
  return <details className="work-query" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><code>{entry.blockId}</code><span>{entry.request?.model}</span></summary>
    {open && <div className="work-query-body">
    {entry.request?.attempts?.map(attempt => <div className={`work-attempt state-${attempt.status}`} key={attempt.index}>
      <strong>{attempt.status === 'started' ? 'Waiting for' : attempt.status === 'failed' ? 'Failed' : 'Answered by'} {attempt.effective}</strong>
      {attempt.ms != null && <span>{duration(attempt.ms)}</span>}{attempt.error && <small>{attempt.error}</small>}
    </div>)}
    {(entry.request?.tokens || entry.request?.costUsd != null || entry.request?.tokensPerSecond != null) && <p className="work-metrics">
      {[entry.request.tokens, entry.request.tokensPerSecond != null ? `${entry.request.tokensPerSecond.toFixed(1)} tokens/s` : null,
        entry.request.costUsd != null ? `$${entry.request.costUsd.toFixed(4)}` : null].filter(Boolean).join(' · ')}
    </p>}
    <dl className="work-query-facts">
      <dt>Finish</dt><dd>{entry.request?.settled ? entry.request.finishReason : 'waiting'}</dd>
      {entry.request?.maxTokens != null && <><dt>Token ceiling</dt><dd>{entry.request.maxTokens.toLocaleString()}</dd></>}
      {entry.request?.route?.line && <><dt>Route</dt><dd>{entry.request.route.line}</dd></>}
    </dl>
    <details><summary>Request sent</summary><QueryPre value={entry.prompt ?? 'This older run did not record the assembled request. Its system and user messages remain in the full Trace log.'} /></details>
    {entry.request?.reasoning && <details><summary>Internal reasoning ({entry.request.reasoning.length.toLocaleString()} chars)</summary><QueryPre value={entry.request.reasoning} /></details>}
    <details open={!entry.request?.content}><summary>Visible response</summary>
      <QueryPre value={entry.request?.content || `No visible response. Finish reason: ${entry.request?.finishReason ?? 'unknown'}.`} />
    </details>
    {entry.calls.map(call => <div className="work-tool" key={call.callId}><strong>{call.name}</strong><span>{call.unfinished ? 'running' : call.error ? 'error' : 'done'}</span></div>)}</div>}
  </details>;
}

const LOG_PAGE = 40;

function DetailsRail({ traceDetails, runId, view, runs, onOpenRun, onOpenTrace }) {
  const [tab, setTab] = useState('log');
  const [visibleLog, setVisibleLog] = useState(LOG_PAGE);
  useEffect(() => setVisibleLog(LOG_PAGE), [runId]);
  const log = useMemo(() => (traceDetails?.turns ?? []).flatMap(turn => turn.steps.map(step => ({
    blockId: step.blockId, step: step.step, prompt: step.prompt, request: step.request, calls: step.tools ?? [],
  }))), [traceDetails]);
  const shownLog = log.slice(-visibleLog);
  const results = Object.entries(view.blocks).filter(([, block]) => block.showing);
  return <aside className="work-details"><div className="work-details-tabs">{['log', 'result', 'runs'].map(name => <button key={name}
    className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {tab === 'log' && <div className="work-log">
      {log.length > 0 && <button type="button" className="work-open-trace" onClick={onOpenTrace}>Open full Trace</button>}
      {log.length ? <>
        {shownLog.length < log.length && <button type="button" className="work-show-earlier" onClick={() => setVisibleLog(count => count + LOG_PAGE)}>
          Show {Math.min(LOG_PAGE, log.length - shownLog.length)} earlier queries
        </button>}
        {shownLog.map((entry, index) => <QueryEntry entry={entry}
          key={`${entry.blockId}:${entry.step}:${log.length - shownLog.length + index}`}
          isLatest={index === shownLog.length - 1} />)}
      </>
      : <p className="muted">Waiting for the first model event…</p>}</div>}
    {tab === 'result' && <div className="work-results">{results.length ? results.map(([id, block]) => <article key={id}><code>{id}</code><pre>{block.showing}</pre></article>)
      : <p className="muted">No output yet.</p>}</div>}
    {tab === 'runs' && <div className="work-runs">{(runs ?? []).map(run => <button key={run.id ?? run.runId} onClick={() => onOpenRun?.(run.id ?? run.runId)}>
      <strong>{run.name ?? run.flowName ?? run.id ?? run.runId}</strong><small>{run.stage ?? run.status}</small></button>)}</div>}
  </aside>;
}

export default function Work({
  stack = null, blocks = null, trace = null, runId = null, composer = null, snapshot = null,
  interaction = null, onDecide = null, onAnswer = null, onReply = null, replyBusy = false,
  runs = [], onOpenRun = null, onNewChat = null, onOpenFlow = null, onOpenTrace = null,
  onRetryFailed = null, retryBusy = false, retryError = '', onRevealRunLog = null,
  onRevealDiagnosticLog = null, onStopRun = null, stopBusy = false,
}) {
  const view = runView(trace);
  const detailedTrace = useMemo(() => traceView(trace), [trace]);
  const [reply, setReply] = useState('');
  const runModels = useMemo(() => [...new Set((trace?.turns ?? []).flatMap(turn => (
    (turn.steps ?? []).map(step => step.request?.model).filter(Boolean)
  )))], [trace]);
  const latestRequest = detailedTrace.turns.flatMap(turn => turn.steps.map(step => step.request)).filter(Boolean).at(-1) ?? null;
  const latestAttempt = latestRequest?.attempts?.at(-1) ?? null;
  const summary = snapshot?.conversation?.filter(turn => turn.role === 'assistant').at(-1) ?? null;
  const runModel = { ...view, summary: summary?.text ?? null, input: snapshot?.meta?.userMessage ?? snapshot?.prompt ?? '' };
  if (!stack) return <div className="v2-work" data-v2>{composer}<p className="muted work-empty">Choose a workflow and send a message to start.</p></div>;
  return <div className="v2-work work-run-mode" data-v2><header className="work-run-head">
    <button type="button" className="work-new-chat" onClick={onNewChat}><span aria-hidden>＋</span> New chat</button>
    <div className="work-run-title"><span className="section-label">{view.running ? 'Block run' : 'Run'}</span><h1>{stack.name ?? stack.id}</h1></div>
    {runModels.length > 0 && <div className="work-run-models" title="Models actually requested by this run"><span>Models</span>{runModels.map(model => <code key={model}>{model}</code>)}</div>}
    <span className={`work-stage stage-${view.stage}`}>{view.stage ?? 'starting'}</span>
    {view.running && <button type="button" className="work-stop" disabled={stopBusy} onClick={onStopRun}>
      {stopBusy ? 'Stopping…' : 'Stop run'}
    </button>}
    <button type="button" className="work-open-flow" onClick={onOpenFlow} title="Open this workflow in Build; Work returns to this same run">Open flow</button>
    <code className="work-run-id">{runId}</code></header>
    {view.error && <section className="work-failure" role="alert">
      <strong>{view.error}</strong><div className="work-failure-actions">
        {view.errorBlockId && <button type="button" className="work-retry" disabled={retryBusy}
          onClick={() => onRetryFailed?.(view.errorBlockId)}>{retryBusy ? 'Restarting…' : `Retry ${view.errorBlockId}`}</button>}
        <button type="button" onClick={onOpenTrace}>Inspect queries</button>
        <button type="button" onClick={onRevealRunLog}>Reveal raw run log</button>
        <button type="button" onClick={onRevealDiagnosticLog}>Show app log</button>
      </div>{retryError && <small>{retryError}</small>}
    </section>}
    {view.warnings?.map(warning => <p className="work-warning" role="status" key={warning.blockId}>
      <strong>{warning.blockId} degraded:</strong> {warning.message}
    </p>)}
    {latestAttempt && <p className={`work-model-status state-${latestAttempt.status}`} role="status">
      <strong>{latestAttempt.status === 'started' ? 'Waiting for' : latestAttempt.status === 'failed' ? 'Model failed' : 'Response from'}</strong>
      <code>{latestAttempt.effective}</code>
      {latestAttempt.error && <span>{latestAttempt.error}</span>}
      {latestRequest.tokensPerSecond != null && <span>{latestRequest.tokensPerSecond.toFixed(1)} tokens/s</span>}
      {latestRequest.costUsd != null && <span>${latestRequest.costUsd.toFixed(4)}</span>}
    </p>}
    {summary?.degraded && <p className="work-warning" role="status"><strong>Post-run conversation summary degraded.</strong> This happened after the workflow settled and did not cause its failure{summary.reason ? `: ${summary.reason}` : '.'}</p>}
    <div className="work-run-grid"><RunRail stack={stack} view={view}/><main className="work-run-main">
      <BlockEditor stack={stack} blocks={blocks} mode="run" run={runModel}/>
      <Interaction interaction={interaction} onDecide={onDecide} onAnswer={onAnswer}/>
      {!view.running && !interaction && <form className="work-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; onReply?.(reply); setReply(''); }}>
        <textarea rows="2" value={reply} onChange={event => setReply(event.target.value)} placeholder="Continue this conversation…" />
        <button type="submit" disabled={replyBusy || !reply.trim()}>{replyBusy ? 'Starting…' : 'Send'}</button></form>}
    </main><DetailsRail traceDetails={detailedTrace} runId={runId} view={view} runs={runs} onOpenRun={onOpenRun} onOpenTrace={onOpenTrace}/></div>
  </div>;
}
