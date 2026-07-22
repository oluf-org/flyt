// The chat-style node feed: the run's graph as a downward-scrolling column of
// cards, in execution order — the ChatGPT scroll pattern, but each "message"
// is a node. New work appends at the bottom; the scroll container (owned by
// ChatRun) sticks to the tail while the user hasn't scrolled up.
//
// Cards carry the same state vocabulary as the canvas (status tokens, kind
// badges, elapsed ticker) plus what the canvas can't show: the live stream
// tail while a node is working and its output/retrospective once it lands.
// Clicking a card opens the same Node Focus panel the canvas Investigate does.
import React, { useEffect, useRef, useState } from 'react';
import { formatElapsed } from './runProgress.js';
import Tip from './Tip.jsx';

const STREAM_LINES = 5;

function StatusGlyph({ status }) {
  if (status === 'done') return <span className="node-status">✓</span>;
  if (status === 'active') return <span className="node-status"><span className="spinner" /></span>;
  if (status === 'waiting') return <span className="node-status">⏸</span>;
  if (status === 'failed') return <span className="node-status">✕</span>;
  if (status === 'queued') return <Tip as="span" className="node-status" text="Queued — waiting for a worker">⋯</Tip>;
  if (status === 'skipped') return <Tip as="span" className="node-status" text="Retired by a follow-up turn — not re-run">↷</Tip>;
  return <span className="node-status" />;
}

// Same ticker rule as the canvas: "first seen active" is stamped by the parent
// (feed data carries activeSince), the second hand ticks from local state.
function ElapsedTicker({ since }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="node-elapsed mono">{formatElapsed(Math.max(0, now - since))}</span>;
}

function streamTail(text) {
  const lines = (text ?? '').replace(/\s+$/, '').split('\n');
  return lines.slice(-STREAM_LINES).join('\n');
}

function FeedCard({ item, selected, onSelect }) {
  const retro = item.retro;
  const hasBody = Boolean(item.streamText || item.outputPreview || retro?.recommendation || retro?.problems?.length);
  return (
    <div
      className={
        `feed-item status-${item.status}` +
        (item.depth > 0 ? ' feed-child' : '') +
        (item.spawned ? ' feed-spawned' : '') +
        (selected ? ' selected' : '')
      }
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(item.id)}
      onKeyDown={e => { if (e.key === 'Enter') onSelect?.(item.id); }}
      aria-label={`${item.label} — ${item.status}`}
    >
      <span className="feed-rail" aria-hidden="true" />
      <div className={`flow-node status-${item.status}` + (item.kind ? ` kind-${item.kind}` : '')}>
        <div className="node-main">
          <span className="node-icon">{item.icon}</span>
          <div className="node-text">
            <div className="node-title-row">
              <div className="node-title">{item.label}</div>
              {item.kind && <span className={`node-kind kind-${item.kind}`}>{item.kind}</span>}
              {item.spawned && <span className="node-kind kind-spawn" title="Created at run time — not in the authored flow">＋spawned</span>}
              {item.turn != null && <span className="node-kind kind-turn" title={`Added by follow-up turn ${item.turn}`}>↩{item.turn}</span>}
              {item.activeSince != null && item.status === 'active' && <ElapsedTicker since={item.activeSince} />}
            </div>
            <div className="node-sub">{item.sub}</div>
          </div>
          <StatusGlyph status={item.status} />
        </div>

        {item.status === 'active' && item.streamText && (
          <pre className="feed-stream">{streamTail(item.streamText)}</pre>
        )}

        {item.status !== 'active' && hasBody && (
          <div className="feed-body">
            {item.outputPreview && (
              <pre className="feed-output">{item.outputPreview}</pre>
            )}
            {retro && (
              <div className="feed-retro">
                {retro.status && (
                  <span className={`feed-retro-status retro-${retro.status}`}>
                    {retro.status}{retro.confidence != null ? ` · ${Math.round(retro.confidence * 100)}%` : ''}
                  </span>
                )}
                {retro.problems?.length > 0 && (
                  <span className="feed-retro-problems" title={retro.problems.join('\n')}>
                    {retro.problems.length} problem{retro.problems.length === 1 ? '' : 's'} noted
                  </span>
                )}
                {retro.recommendation && <span className="feed-retro-note">{retro.recommendation}</span>}
              </div>
            )}
          </div>
        )}

        {item.status === 'waiting' && (
          <div className="feed-waiting">Waiting at the approval gate — decide above to continue.</div>
        )}
      </div>
    </div>
  );
}

export default function NodeFeed({ items, selectedNode, onSelect }) {
  // Stamp first-seen-active per node (run feed only) so the ticker survives
  // the snapshot-push rebuild — same pattern as FlowCanvas.activeSince.
  const activeSince = useRef(new Map());
  const now = Date.now();
  for (const it of items) {
    if (it.status === 'active') {
      if (!activeSince.current.has(it.id)) activeSince.current.set(it.id, now);
      it.activeSince = activeSince.current.get(it.id);
    } else {
      activeSince.current.delete(it.id);
    }
  }

  if (!items.length) return null;
  return (
    <div className="node-feed" aria-label="Run nodes">
      {items.map(it => (
        <FeedCard
          key={it.id}
          item={it}
          selected={selectedNode === it.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
