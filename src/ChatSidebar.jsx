// The chat run's summary sidebar (CHAT-RUN rework): an opt-in right column
// that answers "what has this run produced so far?" without scrolling the
// feed — run-level progress up top, the final answer when there is one, then
// per-node summaries as they land. Toggled from the topbar; the feed stays
// the primary surface.
import React, { useEffect, useState } from 'react';
import { finalAnswer } from './nodeFeedData.js';
import { runProgress, formatElapsed } from './runProgress.js';

const ANSWER_CHARS = 1200;

function SideNode({ item }) {
  const retro = item.retro;
  return (
    <div className={`side-node status-${item.status}`}>
      <div className="side-node-head">
        <span className="node-icon" aria-hidden>{item.icon}</span>
        <span className="side-node-title">{item.label}</span>
        <span className={`side-node-status status-${item.status}`}>{item.status}</span>
      </div>
      {retro && (
        <div className="side-node-retro">
          {retro.status && (
            <span className={`feed-retro-status retro-${retro.status}`}>
              {retro.status}{retro.confidence != null ? ` · ${Math.round(retro.confidence * 100)}%` : ''}
            </span>
          )}
          {retro.problems?.length > 0 && (
            <span className="side-node-problems">{retro.problems.join('; ')}</span>
          )}
          {retro.recommendation && <span className="side-node-note">{retro.recommendation}</span>}
        </div>
      )}
      {!retro && item.outputPreview && <pre className="side-node-output">{item.outputPreview}</pre>}
      {item.status === 'active' && item.streamText && (
        <pre className="side-node-output streaming">{item.streamText.slice(-400)}</pre>
      )}
    </div>
  );
}

export default function ChatSidebar({ snapshot, items }) {
  const p = runProgress(snapshot);
  const answer = finalAnswer(snapshot);

  // Same clock discipline as RunBar: tick only while live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!p?.live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [p?.live]);
  const progress = runProgress(snapshot, now);

  // Only nodes with something to say belong in a summary — pending rows are noise.
  const said = items.filter(it =>
    it.status === 'done' || it.status === 'failed' || it.status === 'active' || it.retro);

  return (
    <aside className="chat-side" aria-label="Run summary">
      <div className="chat-side-head">
        <span className="section-label">Summary</span>
        {progress && (
          <span className="mono chat-side-elapsed" title="Elapsed">{formatElapsed(progress.elapsedMs)}</span>
        )}
      </div>

      {progress && (
        <div className="side-progress">
          <div className="run-meter" role="progressbar"
            aria-valuenow={progress.done} aria-valuemin={0} aria-valuemax={progress.total}
            title={`${progress.done} of ${progress.total} nodes done`}>
            <span className="run-meter-fill" style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
          </div>
          <div className="side-progress-stats mono">
            <span>{progress.done}/{progress.total} done</span>
            {progress.active > 0 && <span className="run-stat-active">{progress.active} working</span>}
            {progress.waiting > 0 && <span>{progress.waiting} waiting</span>}
            {progress.failed > 0 && <span className="run-stat-fail">{progress.failed} failed</span>}
          </div>
        </div>
      )}

      {answer && (
        <section className="side-answer">
          <span className="section-label">Final answer</span>
          <pre>{answer.length > ANSWER_CHARS ? answer.slice(0, ANSWER_CHARS).trimEnd() + '…' : answer}</pre>
        </section>
      )}

      <div className="side-nodes">
        {said.length === 0 && <span className="side-empty">Nothing to summarize yet — the run just started.</span>}
        {said.map(it => <SideNode key={it.id} item={it} />)}
      </div>
    </aside>
  );
}
