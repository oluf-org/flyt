import React, { useMemo, useState } from 'react';
import BlockEditor from './BlockEditor.jsx';
import { runView } from './runView.js';
import './workStyles.css';

function blockNodes(node, out = []) {
  if (!node) return out;
  if (node.kind === 'block') out.push(node);
  else {
    for (const child of node.children ?? []) blockNodes(child, out);
    if (node.kind === 'if') for (const child of node.else ?? []) blockNodes(child, out);
  }
  return out;
}

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
      {interaction.options.map(option => <button key={option} onClick={() => setAnswer(option)} className={answer === option ? 'active' : ''}>{option}</button>)}</div>}
    <textarea rows="3" value={answer} onChange={event => setAnswer(event.target.value)} placeholder="Answer this block directly" />
    <button className="work-allow" disabled={!answer.trim()} onClick={() => onAnswer?.(answer)}>Send answer to block</button></section>;
}

function RunRail({ stack, view }) {
  return <aside className="work-run-rail" aria-label="Run progress"><span className="section-label">Run</span>
    {blockNodes(stack.root).map((node, index) => { const status = view.blocks[node.id]?.status ?? 'pending'; return <div key={node.id} className={`work-rail-step state-${status}`}>
      <span className="work-rail-index">{status === 'done' ? '✓' : status === 'failed' ? '!' : index + 1}</span><span><strong>{node.title ?? node.id}</strong><small>{status}</small></span></div>; })}
  </aside>;
}

function DetailsRail({ watching, view, runs, onOpenRun }) {
  const [tab, setTab] = useState('log');
  const log = useMemo(() => (watching?.trace?.turns ?? []).flatMap(turn => turn.steps.map(step => ({
    blockId: step.blockId, model: step.request?.model, content: step.request?.content, calls: step.toolCalls ?? [],
  }))), [watching]);
  const results = Object.entries(view.blocks).filter(([, block]) => block.showing);
  return <aside className="work-details"><div className="work-details-tabs">{['log', 'result', 'runs'].map(name => <button key={name}
    className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>{name}</button>)}</div>
    {tab === 'log' && <div className="work-log">{log.length ? log.map((entry, index) => <article key={index}><header><code>{entry.blockId}</code><span>{entry.model}</span></header>
      {entry.content && <p>{entry.content}</p>}{entry.calls.map(call => <div className="work-tool" key={call.callId}><strong>{call.name}</strong><span>{call.finished ? 'done' : 'running'}</span></div>)}</article>)
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
  runs = [], onOpenRun = null,
}) {
  const view = runView(trace);
  const [reply, setReply] = useState('');
  const summary = snapshot?.conversation?.filter(turn => turn.role === 'assistant').at(-1) ?? null;
  const runModel = { ...view, summary: summary?.text ?? null, input: snapshot?.meta?.userMessage ?? snapshot?.prompt ?? '' };
  if (!stack) return <div className="v2-work" data-v2>{composer}<p className="muted work-empty">Choose a workflow and send a message to start.</p></div>;
  return <div className="v2-work work-run-mode" data-v2><header className="work-run-head"><div><span className="section-label">{view.running ? 'Block run' : 'Run'}</span>
    <h1>{stack.name ?? stack.id}</h1></div><span className={`work-stage stage-${view.stage}`}>{view.stage ?? 'starting'}</span><code>{runId}</code></header>
    {view.error && <p className="work-error" role="alert">{view.error}</p>}
    {summary?.degraded && <p className="work-warning" role="status">Conversation summary used the deterministic fallback{summary.reason ? `: ${summary.reason}` : '.'}</p>}
    <div className="work-run-grid"><RunRail stack={stack} view={view}/><main className="work-run-main">
      <BlockEditor stack={stack} blocks={blocks} mode="run" run={runModel}/>
      <Interaction interaction={interaction} onDecide={onDecide} onAnswer={onAnswer}/>
      {!view.running && !interaction && <form className="work-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; onReply?.(reply); setReply(''); }}>
        <textarea rows="2" value={reply} onChange={event => setReply(event.target.value)} placeholder="Continue this conversation…" />
        <button type="submit" disabled={replyBusy || !reply.trim()}>{replyBusy ? 'Starting…' : 'Send'}</button></form>}
    </main><DetailsRail watching={{ trace }} view={view} runs={runs} onOpenRun={onOpenRun}/></div>
  </div>;
}
