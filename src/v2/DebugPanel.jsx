import React, { useEffect, useMemo, useState } from 'react';
import { debugOutputHistory, debugReportMarkdown } from './debugView.js';

function OutputComparison({ history, selectedBlock }) {
  const attempts = history[selectedBlock] ?? [];
  if (!selectedBlock) return <p className="debug-empty">The debugger did not identify a block to compare.</p>;
  if (!attempts.length) return <p className="debug-empty">No completed output was recorded for <code>{selectedBlock}</code>.</p>;
  return <div className="debug-output-list">
    {attempts.map((attempt, index) => <details key={`${attempt.at}:${index}`} open={index === attempts.length - 1}>
      <summary><span>Output {index + 1}{index === attempts.length - 1 ? ' · latest' : ''}</span><time>{attempt.at ? new Date(attempt.at).toLocaleString() : 'time not recorded'}</time></summary>
      <pre>{attempt.content || '[empty output]'}</pre>
    </details>)}
    {attempts.length === 1 && <small>Retry this block to preserve a second output here for comparison.</small>}
  </div>;
}

export default function DebugPanel({
  runId, trace, view, report, busy = false, error = '', retryBusy = false,
  onAnalyze, onRetry, onClose, onOpenTrace, onRevealRunLog,
}) {
  const history = useMemo(() => debugOutputHistory(trace), [trace]);
  const blockIds = useMemo(() => [...new Set([
    ...Object.keys(view?.blocks ?? {}), ...Object.keys(history), report?.suspectedBlockId,
  ].filter(Boolean))], [view, history, report]);
  const [blockId, setBlockId] = useState('');
  const [guidance, setGuidance] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  useEffect(() => {
    const next = report?.suspectedBlockId ?? view?.errorBlockId ?? blockIds[0] ?? '';
    setBlockId(next);
    setGuidance(report?.suggestedPrompt ?? '');
  }, [runId, report, view?.errorBlockId]);

  const copy = async () => {
    await navigator.clipboard.writeText(debugReportMarkdown(report, runId));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  const canRetry = blockId && !view?.running && !view?.paused && !view?.stopping;

  return <div className="debug-backdrop" role="presentation" onMouseDown={onClose}>
    <aside className="debug-panel" role="dialog" aria-modal="true" aria-labelledby="debug-title" onMouseDown={event => event.stopPropagation()}>
      <header><div><span className="section-label">DEVELOPMENT TOOL</span><h2 id="debug-title">Agent debugger</h2>
        <p>Reads this run’s durable record. It never changes anything until you retry a block.</p></div>
        <button type="button" className="debug-close" onClick={onClose} aria-label="Close debugger">×</button></header>

      <div className="debug-toolbar">
        <button type="button" className="debug-analyze" disabled={busy} onClick={onAnalyze}>{busy ? 'Investigating…' : report ? 'Re-analyze run' : 'Analyze run'}</button>
        {report && <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy bug report'}</button>}
        <button type="button" onClick={onOpenTrace}>Open full Trace</button>
        <button type="button" onClick={onRevealRunLog}>Reveal raw log</button>
      </div>
      {error && <p className="debug-error" role="alert">{error}</p>}
      {busy && !report && <div className="debug-thinking" aria-live="polite"><span/><div><strong>Following the evidence through the workflow</strong><small>Prompts, routes, attempts, tools, permissions, outputs, and the terminal error.</small></div></div>}

      {report && <div className="debug-body">
        <section className="debug-verdict">
          <div className="debug-verdict-head"><span className={`debug-confidence ${report.confidence}`}>{report.confidence} confidence</span>
            <span>{report.model ? `Agent · ${report.model}` : 'Deterministic fallback'}</span></div>
          <h3>{report.summary || 'Investigation complete'}</h3>
          <p className="debug-cause">{report.probableCause}</p>
          {report.reason && <small className="debug-degraded">The model investigation was unavailable: {report.reason}</small>}
        </section>

        <div className="debug-columns">
          <section><span className="section-label">EVIDENCE</span>{report.evidence?.length
            ? <ul>{report.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul>
            : <p className="debug-empty">No conclusive low-level evidence was recorded.</p>}</section>
          <section><span className="section-label">LOOK HERE</span>{report.suggestedAreas?.length
            ? <ul>{report.suggestedAreas.map((item, index) => <li key={index}>{item}</li>)}</ul>
            : <p className="debug-empty">Open Trace and inspect the last incomplete event.</p>}</section>
        </div>

        <section className="debug-retry-card">
          <div><span className="section-label">CONTROLLED RETRY</span><h3>{report.recommendedAction || 'Retry with a targeted instruction'}</h3></div>
          <label>Block<select value={blockId} onChange={event => setBlockId(event.target.value)}>
            {!blockIds.length && <option value="">No block available</option>}
            {blockIds.map(id => <option key={id} value={id}>{id}</option>)}
          </select></label>
          <label>Prompt guidance for this retry<textarea rows="4" value={guidance} onChange={event => setGuidance(event.target.value)}
            placeholder="Tell this block what to do differently. This is appended only to the retried attempt."/></label>
          <button type="button" className="debug-retry" disabled={!canRetry || retryBusy}
            onClick={() => onRetry?.(blockId, guidance)}>{retryBusy ? 'Restarting block…' : `Retry ${blockId || 'block'} with this prompt`}</button>
          {!canRetry && <small>{view?.running || view?.paused ? 'Stop the live run before retrying a block.' : 'This run has no retryable block.'}</small>}
        </section>

        <section className="debug-compare"><span className="section-label">OUTPUT COMPARISON</span><h3>{blockId ? `Attempts for ${blockId}` : 'Attempts'}</h3>
          <OutputComparison history={history} selectedBlock={blockId}/></section>
      </div>}
    </aside>
  </div>;
}
