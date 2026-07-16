import React, { useEffect, useRef, useState } from 'react';
import { activeStreams } from './runStreams.js';

// Live output panel (V1 task 8, D10): what the run is saying RIGHT NOW.
// Without it a real-model run is minutes of apparent silence — the canvas
// animates, but nothing shows the actual work until a node completes.
//
// A pure view over the run snapshot the main process already pushes; what
// counts as "working" lives in runStreams.js.
export default function LiveStream({ snapshot }) {
  const streams = activeStreams(snapshot);
  // Which stream the panel shows. `pinned` is the user's explicit choice and
  // wins; otherwise we follow whichever stream is actually moving.
  const [pinned, setPinned] = useState(null);
  const [followed, setFollowed] = useState(null);
  const seen = useRef(new Map()); // stream key -> text at the last snapshot
  const bodyRef = useRef(null);
  const stick = useRef(true); // keep pinning the view to the newest tokens?

  // Stream keys (task-1, …) repeat across runs, so a choice made about one run
  // must not silently rebind to another run's work when the view switches.
  // Declared first so the tracking effect below repopulates in the same pass.
  useEffect(() => {
    setPinned(null);
    setFollowed(null);
    seen.current = new Map();
  }, [snapshot?.meta?.runId]);

  useEffect(() => {
    const next = new Map();
    const moved = [];
    for (const s of streams) {
      next.set(s.key, s.text);
      if (s.text && seen.current.get(s.key) !== s.text) moved.push(s.key);
    }
    seen.current = next;
    setFollowed(prev => {
      // Stay with the current stream as long as it is still producing. Parallel
      // tasks (V1 task 6) mean several move between pushes, and "whatever moved
      // last" on its own would ping-pong the panel every 250ms.
      if (moved.includes(prev)) return prev;
      if (moved.length) return moved[0];
      return streams.some(s => s.key === prev) ? prev : (streams[0]?.key ?? null);
    });
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  const focusKey = streams.some(s => s.key === pinned) ? pinned : followed;
  const focus = streams.find(s => s.key === focusKey) ?? streams[0] ?? null;

  // Follow the tail as tokens arrive, unless the user has scrolled up to read
  // something — then leave their position alone until they return to the end.
  useEffect(() => { stick.current = true; }, [focus?.key]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [focus?.key, focus?.text]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  if (!streams.length || !focus) return null;

  return (
    <section className="live-panel" aria-label="Live output">
      <div className="live-head">
        <span className="live-dot" aria-hidden />
        <span className="section-label">Live</span>
        {streams.length > 1 && (
          <span className="live-count">{streams.length} nodes working</span>
        )}
      </div>

      {streams.length > 1 && (
        <div className="live-tabs" role="tablist" aria-label="Working nodes">
          {streams.map(s => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={s.key === focus.key}
              className={'live-tab' + (s.key === focus.key ? ' active' : '') + (s.key === pinned ? ' pinned' : '')}
              title={s.key === pinned
                ? `${s.label} — pinned. Click again to follow whichever node is working.`
                : `${s.label} — click to pin the panel here.`}
              onClick={() => setPinned(p => (p === s.key ? null : s.key))}
            >
              <span className="live-tab-icon" aria-hidden>{s.icon}</span>
              <span className="live-tab-label">{s.label}</span>
            </button>
          ))}
        </div>
      )}

      <div className="live-meta">
        <span className="live-title" title={focus.label}>{focus.label}</span>
        <span className="live-sub mono" title={focus.sub}>{focus.sub}</span>
      </div>

      <pre className="live-body" ref={bodyRef} onScroll={onScroll}>
        {focus.text
          ? <>{focus.text}<span className="live-caret" aria-hidden /></>
          : <span className="live-idle">Waiting for the first tokens…</span>}
      </pre>
    </section>
  );
}
