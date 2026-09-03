import React, { useEffect, useMemo, useRef, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import { runView } from './runView.js';
import { traceView, duration } from './traceView.js';
import { groupRuns, runStatus, runTimeLabel, runTimeTitle } from '../runList.js';
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

function HistoryIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6.5h14M5 12h14M5 17.5h9"/></svg>;
}

function ChevronIcon({ left = false }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={left ? 'm14 7-5 5 5 5' : 'm10 7 5 5-5 5'}/></svg>;
}

function ChatHistory({ runs, activeRunId, onOpenRun, onNewChat }) {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('flyt.workHistoryCollapsed') === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('flyt.workHistoryCollapsed', String(collapsed)); }
    catch { /* A private or locked-down renderer may not expose storage. */ }
  }, [collapsed]);
  const groups = groupRuns(runs ?? []);
  return <aside className={`work-history${collapsed ? ' collapsed' : ''}`} aria-label="Chat history">
    <div className="work-history-head">
      <button type="button" className="work-history-new" onClick={onNewChat} title="New chat">
        <span aria-hidden="true">＋</span><span className="work-history-copy">New chat</span>
      </button>
      <button type="button" className="work-history-toggle" onClick={() => setCollapsed(value => !value)}
        aria-label={collapsed ? 'Expand chat history' : 'Minimize chat history'} aria-expanded={!collapsed}>
        <ChevronIcon left={!collapsed}/>
      </button>
    </div>
    <div className="work-history-list">
      {!groups.length && <p className="work-history-empty"><HistoryIcon/><span className="work-history-copy">Your chats will appear here.</span></p>}
      {groups.map(group => <section className="work-history-group" key={group.key}>
        <span className="section-label work-history-copy">{group.label}</span>
        {group.runs.map(run => {
          const id = run.id ?? run.runId;
          const status = runStatus(run);
          return <button type="button" className={`work-history-item${id === activeRunId ? ' active' : ''}`}
            key={id} onClick={() => onOpenRun?.(id)} aria-current={id === activeRunId ? 'page' : undefined}
            title={`${run.name ?? run.flowName ?? id}\n${runTimeTitle(run)} · ${status.label}`}>
            <span className={`work-history-state ${status.kind}`} aria-hidden="true"/>
            <span className="work-history-copy"><strong>{run.name ?? run.flowName ?? 'Untitled chat'}</strong>
              <small><time>{runTimeLabel(run)}</time>{status.kind !== 'done' && <span>{status.label}</span>}</small></span>
          </button>;
        })}
      </section>)}
    </div>
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

function DetailsRail({ traceDetails, runId, view, onOpenTrace }) {
  const [tab, setTab] = useState('log');
  const [visibleLog, setVisibleLog] = useState(LOG_PAGE);
  useEffect(() => setVisibleLog(LOG_PAGE), [runId]);
  const log = useMemo(() => (traceDetails?.turns ?? []).flatMap(turn => turn.steps.map(step => ({
    blockId: step.blockId, step: step.step, prompt: step.prompt, request: step.request, calls: step.tools ?? [],
  }))), [traceDetails]);
  const shownLog = log.slice(-visibleLog);
  const results = Object.entries(view.blocks).filter(([, block]) => block.showing);
  return <aside className="work-details"><div className="work-details-tabs">{['log', 'result'].map(name => <button key={name}
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
  </aside>;
}

const STAGE_LABELS = {
  prompt: 'Queued', planning: 'Planning', routing: 'Routing', execution: 'Running', resumed: 'Running',
  awaiting_approval: 'Needs approval', awaiting_input: 'Needs an answer', pausing: 'Pausing', paused: 'Paused',
  stopping: 'Stopping', stopped: 'Stopped', verification: 'Verifying', done: 'Done', failed: 'Failed',
  rejected: 'Rejected', interrupted: 'Interrupted', cancelled: 'Stopped',
};

function RunActions({ view, onPauseRun, onResumeRun, onStopRun, onOpenFlow, pauseBusy, resumeBusy, stopBusy }) {
  const menu = useRef(null);
  const label = STAGE_LABELS[view.stage] ?? (view.stage ? view.stage.replaceAll('_', ' ') : 'Starting');
  useEffect(() => {
    const close = event => {
      if (event.key === 'Escape' || (menu.current?.open && !menu.current.contains(event.target))) menu.current?.removeAttribute('open');
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, []);
  const act = callback => event => { event.currentTarget.closest('details')?.removeAttribute('open'); callback?.(); };
  return <details className="work-run-actions" ref={menu}>
    <summary className={`work-stage stage-${view.stage}`} aria-label={`${label} — run actions`}><span>{label}</span><ChevronIcon/></summary>
    <div className="work-run-menu">
      {view.resumable && <button type="button" disabled={resumeBusy} onClick={act(onResumeRun)}>
        <span aria-hidden="true">▶</span>{resumeBusy ? 'Resuming…' : 'Resume run'}
      </button>}
      {view.running && !view.paused && !view.stopping && <button type="button" disabled={pauseBusy || view.pausing} onClick={act(onPauseRun)}>
        <span aria-hidden="true">Ⅱ</span>{pauseBusy || view.pausing ? 'Pausing…' : 'Pause run'}
      </button>}
      {(view.running || view.paused) && <button type="button" className="danger" disabled={stopBusy || view.stopping} onClick={act(onStopRun)}>
        <span aria-hidden="true">■</span>{stopBusy || view.stopping ? 'Stopping…' : 'Stop run'}
      </button>}
      <button type="button" onClick={act(onOpenFlow)}><span aria-hidden="true">↗</span>Open builder</button>
      {(view.stage === 'stopped' || view.stage === 'interrupted') && <p>Resume continues from the last durable block.</p>}
    </div>
  </details>;
}

export default function Work({
  stack = null, blocks = null, trace = null, runId = null, composer = null, snapshot = null,
  interaction = null, onDecide = null, onAnswer = null, onReply = null, replyBusy = false,
  runs = [], onOpenRun = null, onNewChat = null, onOpenFlow = null, onOpenTrace = null,
  onRetryFailed = null, retryBusy = false, retryError = '', controlError = '', onRevealRunLog = null,
  onRevealDiagnosticLog = null, onStopRun = null, stopBusy = false,
  onPauseRun = null, pauseBusy = false, onResumeRun = null, resumeBusy = false,
}) {
  const view = runView(trace);
  const detailedTrace = useMemo(() => traceView(trace), [trace]);
  const [reply, setReply] = useState('');
  const summary = snapshot?.conversation?.filter(turn => turn.role === 'assistant').at(-1) ?? null;
  const runModel = { ...view, summary: summary?.text ?? null, input: snapshot?.meta?.userMessage ?? snapshot?.prompt ?? '' };
  const history = <ChatHistory runs={runs} activeRunId={runId} onOpenRun={onOpenRun} onNewChat={onNewChat}/>;
  if (!stack) return <div className="v2-work" data-v2>{history}<section className="work-surface">{composer}<p className="muted work-empty">Choose a workflow and send a message to start.</p></section></div>;
  return <div className="v2-work work-run-mode" data-v2>{history}<section className="work-surface"><header className="work-run-head">
    <div className="work-run-title"><span className="section-label">{view.running ? 'Running workflow' : 'Workflow run'}</span><h1>{stack.name ?? stack.id}</h1></div>
    <RunActions view={view} onPauseRun={onPauseRun} onResumeRun={onResumeRun} onStopRun={onStopRun} onOpenFlow={onOpenFlow}
      pauseBusy={pauseBusy} resumeBusy={resumeBusy} stopBusy={stopBusy}/></header>
    {controlError && <p className="work-error" role="alert">{controlError}</p>}
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
    {summary?.degraded && <p className="work-warning" role="status"><strong>Post-run conversation summary degraded.</strong> This happened after the workflow settled and did not cause its failure{summary.reason ? `: ${summary.reason}` : '.'}</p>}
    <div className="work-run-grid"><main className="work-run-main">
      <BlockEditor stack={stack} blocks={blocks} mode="run" run={runModel}/>
      <Interaction interaction={interaction} onDecide={onDecide} onAnswer={onAnswer}/>
      {!view.running && !view.resumable && !view.stopping && !interaction && <form className="work-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; onReply?.(reply); setReply(''); }}>
        <textarea rows="2" value={reply} onChange={event => setReply(event.target.value)} placeholder="Continue this conversation…" />
        <button type="submit" disabled={replyBusy || !reply.trim()}>{replyBusy ? 'Starting…' : 'Send'}</button></form>}
    </main><DetailsRail traceDetails={detailedTrace} runId={runId} view={view} onOpenTrace={onOpenTrace}/></div>
  </section></div>;
}
