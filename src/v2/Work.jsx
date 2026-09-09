import React, { useEffect, useMemo, useRef, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import { workflowActions } from '../../core/lifecycle.js';
import { createRunView } from './runView.js';
import { groupRuns, runStatus, runTimeLabel, runTimeTitle } from '../runList.js';
import DebugPanel from './DebugPanel.jsx';
import ActivityIcon from '../ActivityIcon.jsx';
import { loopLabel } from '../activityFormat.js';
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

function ChatHistory({ runs, activeRunId, onOpenRun, onNewChat, onOpenHistory }) {
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
  if (collapsed) return <button type="button" className="work-history-reopen"
    onClick={() => setCollapsed(false)} aria-label="Show chat history" aria-expanded="false"
    title="Show chat history"><ChevronIcon/></button>;
  return <aside className="work-history" aria-label="Chat history">
    <div className="work-history-head">
      <button type="button" className="work-history-new" onClick={onNewChat} title="New chat">
        <span aria-hidden="true">＋</span><span className="work-history-copy">New chat</span>
      </button>
      <button type="button" className="work-history-toggle" onClick={() => setCollapsed(true)}
        aria-label="Hide chat history" aria-expanded="true">
        <ChevronIcon left/>
      </button>
    </div>
    <div className="work-history-list">
      {onOpenHistory && <button className="work-history-item" onClick={onOpenHistory}><HistoryIcon/><span>All conversations ↗</span></button>}
      {!groups.length && <p className="work-history-empty"><HistoryIcon/><span className="work-history-copy">Your chats will appear here.</span></p>}
      {groups.map(group => <section className="work-history-group" key={group.key}>
        <span className="section-label work-history-copy">{group.label}</span>
        {group.runs.map(run => {
          const id = run.id ?? run.runId;
          const status = run.kind === 'loop' ? { ...runStatus(run), label: loopLabel(run.status) } : runStatus(run);
          return <button type="button" className={`work-history-item${id === activeRunId ? ' active' : ''}`}
            key={id} onClick={() => onOpenRun?.(id)} aria-current={id === activeRunId ? 'page' : undefined}
            title={`${run.name ?? run.flowName ?? id}\n${runTimeTitle(run)} · ${status.label}`}>
            <ActivityIcon kind={run.kind} id={id} size={20}/>
            <span className="work-history-copy"><strong>{run.name ?? run.flowName ?? 'Untitled chat'}</strong>
              <small><time>{runTimeLabel(run)}</time>{status.kind !== 'done' && <span>{status.label}</span>}</small></span>
          </button>;
        })}
      </section>)}
    </div>
  </aside>;
}

const STAGE_LABELS = {
  prompt: 'Queued', planning: 'Planning', routing: 'Routing', execution: 'Running', resumed: 'Running',
  awaiting_approval: 'Needs approval', awaiting_input: 'Needs an answer', pausing: 'Pausing', paused: 'Paused',
  stopping: 'Stopping', stopped: 'Stopped', verification: 'Verifying', done: 'Done', failed: 'Failed',
  rejected: 'Rejected', interrupted: 'Interrupted', cancelled: 'Stopped',
};

function RunActions({ view, onPauseRun, onResumeRun, onStopRun, onRetryCleanup, onOpenFlow, onOpenDebug, pauseBusy, resumeBusy, stopBusy }) {
  const menu = useRef(null);
  const actions = view.actions ?? workflowActions(view.stage, view.lifecycle);
  const cleaning = view.lifecycle?.phase === 'settled' && ['running', 'failed', 'pending'].includes(view.lifecycle.cleanup);
  const label = (cleaning ? (view.lifecycle.cleanup === 'failed' ? 'Cleanup needs attention' : 'Finishing cleanup') : STAGE_LABELS[view.stage]) ?? (view.stage ? view.stage.replaceAll('_', ' ') : 'Starting');
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
      {actions.canResume && <button type="button" disabled={resumeBusy} onClick={act(onResumeRun)}>
        <span aria-hidden="true">▶</span>{resumeBusy ? 'Resuming…' : 'Resume run'}
      </button>}
      {actions.canPause && <button type="button" disabled={pauseBusy || view.pausing} onClick={act(onPauseRun)}>
        <span aria-hidden="true">Ⅱ</span>{pauseBusy || view.pausing ? 'Pausing…' : 'Pause run'}
      </button>}
      {actions.canStop && <button type="button" className="danger" disabled={stopBusy} onClick={act(onStopRun)}>
        <span aria-hidden="true">■</span>{stopBusy || view.stopping ? 'Stopping…' : 'Stop run'}
      </button>}
      {actions.canRetryCleanup && <button type="button" disabled={resumeBusy} onClick={act(onRetryCleanup)}>Retry cleanup</button>}
      {actions.reason && <p>{actions.reason}</p>}
      <button type="button" onClick={act(onOpenFlow)}><span aria-hidden="true">↗</span>Open builder</button>
      <button type="button" className="debug-menu-entry" onClick={act(onOpenDebug)}><span aria-hidden="true">⌁</span>Debug workflow</button>
      {(view.stage === 'stopped' || view.stage === 'interrupted') && <p>Resume continues from the last durable block.</p>}
    </div>
  </details>;
}

function ReplyComposer({ onReply, replyBusy, visible, draft }) {
  const [reply, setReply] = useState(() => draft?.value ?? '');
  const update = value => { if (draft) draft.value = value; setReply(value); };
  if (!visible) return null;
  return <form className="work-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; onReply?.(reply); update(''); }}>
    <textarea rows="2" value={reply} onChange={event => update(event.target.value)} placeholder="Continue this conversation…" />
    <button type="submit" disabled={replyBusy || !reply.trim()}>{replyBusy ? 'Starting…' : 'Send'}</button>
  </form>;
}

export default function Work({
  stack = null, blocks = null, trace = null, runId = null, composer = null, snapshot = null,
  interaction = null, onDecide = null, onAnswer = null, onReply = null, replyBusy = false, replyDraft = null,
  runs = [], onOpenRun = null, onNewChat = null, onOpenHistory = null, onOpenFlow = null, onOpenTrace = null,
  onRetryFailed = null, retryBusy = false, retryError = '', controlError = '', onRevealRunLog = null,
  onRevealDiagnosticLog = null, onStopRun = null, stopBusy = false,
  onPauseRun = null, pauseBusy = false, onResumeRun = null, resumeBusy = false,
  onDebugRun = null, onRetryCleanup = null,
}) {
  const projectView = useMemo(() => createRunView(), [runId]);
  const view = useMemo(() => projectView(trace, snapshot), [projectView, trace, snapshot]);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugReport, setDebugReport] = useState(null);
  const [debugError, setDebugError] = useState('');
  useEffect(() => {
    setDebugOpen(false); setDebugBusy(false); setDebugReport(null); setDebugError('');
  }, [runId]);
  const analyze = async () => {
    if (!runId || !onDebugRun || debugBusy) return;
    setDebugBusy(true); setDebugError('');
    try { setDebugReport(await onDebugRun(runId)); }
    catch (error) { setDebugError(String(error?.message ?? error)); }
    finally { setDebugBusy(false); }
  };
  const openDebug = () => {
    setDebugOpen(true);
    if (!debugReport && !debugBusy) analyze();
  };
  const summary = snapshot?.conversation?.filter(turn => turn.role === 'assistant').at(-1) ?? null;
  const runModel = { ...view, summary: summary?.text ?? null, input: snapshot?.meta?.userMessage ?? snapshot?.prompt ?? '' };
  const history = <ChatHistory runs={runs} activeRunId={runId} onOpenRun={onOpenRun} onNewChat={onNewChat} onOpenHistory={onOpenHistory}/>;
  if (!stack) return <div className="v2-work" data-v2>{history}<section className="work-surface">{composer}<p className="muted work-empty">Choose a workflow and send a message to start.</p></section></div>;
  return <div className="v2-work work-run-mode" data-v2>{history}<section className="work-surface"><header className="work-run-head">
    <div className="work-run-title"><span className="section-label">{view.running ? 'Running workflow' : 'Workflow run'}</span><h1>{stack.name ?? stack.id}</h1></div>
    <RunActions onRetryCleanup={onRetryCleanup} view={view} onPauseRun={onPauseRun} onResumeRun={onResumeRun} onStopRun={onStopRun} onOpenFlow={onOpenFlow} onOpenDebug={openDebug}
      pauseBusy={pauseBusy} resumeBusy={resumeBusy} stopBusy={stopBusy}/></header>
    {controlError && <p className="work-error" role="alert">{controlError}</p>}
    {view.error && <section className="work-failure" role="alert">
      <strong>{view.error}</strong><div className="work-failure-actions">
        {view.errorBlockId && <button type="button" className="work-retry" disabled={retryBusy || ['running', 'failed', 'pending'].includes(view.lifecycle?.cleanup) && view.lifecycle?.phase === 'settled'}
          onClick={() => onRetryFailed?.(view.errorBlockId)}>{retryBusy ? 'Restarting…' : `Retry ${view.errorBlockId}`}</button>}
        <button type="button" onClick={onOpenTrace}>Inspect queries</button>
        <button type="button" onClick={onRevealRunLog}>Reveal raw run log</button>
        <button type="button" onClick={onRevealDiagnosticLog}>Show app log</button>
      </div>{retryError && <small>{retryError}</small>}
    </section>}
    {summary?.degraded && <p className="work-warning" role="status"><strong>Post-run conversation summary degraded.</strong> This happened after the workflow settled and did not cause its failure{summary.reason ? `: ${summary.reason}` : '.'}</p>}
    <div className="work-run-grid"><main className="work-run-main">
      <BlockEditor stack={stack} blocks={blocks} mode="run" run={runModel}/>
      <Interaction interaction={interaction} onDecide={onDecide} onAnswer={onAnswer}/>
      <ReplyComposer key={runId} visible={!view.running && !view.resumable && !view.stopping && !interaction} onReply={onReply} replyBusy={replyBusy} draft={replyDraft}/>
    </main></div>
    {debugOpen && <DebugPanel runId={runId} trace={trace} view={view} report={debugReport} busy={debugBusy} error={debugError}
      retryBusy={retryBusy} onAnalyze={analyze} onRetry={onRetryFailed} onClose={() => setDebugOpen(false)}
      onOpenTrace={onOpenTrace} onRevealRunLog={onRevealRunLog}/>}
  </section></div>;
}
