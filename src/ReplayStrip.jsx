import React from 'react';

// The replay scrubber (flare 6): a strip over the canvas for a FINISHED run.
// Dragging the range scrubs through the folded frames; play steps them in event
// order. The parent overlays the current frame's status onto the canvas, so the
// canvas replays without knowing it. Timestamps are tabular so they don't jitter.
export default function ReplayStrip({ frames, index, playing, onScrub, onPlayToggle }) {
  if (!frames?.length) return null;
  const last = frames.length - 1;
  const i = index == null ? last : index;
  const f = frames[i];
  const rel = Math.max(0, (f.t - frames[0].t) / 1000);
  const stamp = `${Math.floor(rel / 60)}:${String(Math.floor(rel % 60)).padStart(2, '0')}`;
  const atEnd = i >= last;

  return (
    <div className="replay-strip">
      <button
        type="button"
        className="replay-play"
        onClick={onPlayToggle}
        aria-label={playing ? 'Pause replay' : 'Play replay'}
        title={playing ? 'Pause' : 'Play from here'}
      >{playing ? '❚❚' : '▶'}</button>

      <input
        className="replay-range"
        type="range"
        min={0}
        max={last}
        value={i}
        onChange={e => onScrub(Number(e.target.value))}
        aria-label="Replay position"
      />

      <span className="replay-time mono">{stamp}</span>
      <span className="replay-line mono" title={f.line}>
        {atEnd && !playing ? 'final' : f.line}
      </span>
    </div>
  );
}
