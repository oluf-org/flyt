import React, { useEffect, useState } from 'react';
import { runProgress, formatElapsed } from './runProgress.js';

// The run view's header (V1 task 9). D4 makes the canvas the live transparency
// view of execution; this is the frame around it that answers "how far along is
// this, is it still moving, and how do I get to the files?" — none of which the
// canvas can say without the user counting glyphs.
export default function RunBar({ snapshot, onOpenFolder, onOpenWorkspace }) {
  const [now, setNow] = useState(() => Date.now());
  const p = runProgress(snapshot, now);
  const live = Boolean(p?.live);

  // Tick only while the run is live. A finished run's clock is frozen at its
  // last write, so re-rendering it every second would be pure waste.
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);

  if (!p) return null;

  const workspace = snapshot.meta?.workspace;
  const pct = p.total ? (p.done / p.total) * 100 : 0;
  // Failures are the one thing worth interrupting the neutral bar for.
  const failPct = p.total ? (p.failed / p.total) * 100 : 0;

  return (
    <div className="run-bar">
      <span className="run-bar-name" title={snapshot.meta?.flowName}>
        {snapshot.meta?.flowName ?? 'Run'}
      </span>

      <div
        className="run-meter"
        role="progressbar"
        aria-valuenow={p.done}
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-label="Nodes completed"
        title={`${p.done} of ${p.total} nodes done`}
      >
        <span className="run-meter-fill" style={{ width: `${pct}%` }} />
        {p.failed > 0 && <span className="run-meter-fail" style={{ width: `${failPct}%` }} />}
      </div>

      <span className="run-stat mono">{p.done}/{p.total}</span>
      {p.active > 0 && (
        <span className="run-stat run-stat-active">
          <span className="live-dot" aria-hidden />
          {p.active} working
        </span>
      )}
      {/* Spawned tasks run inside their node, so they'd otherwise be invisible
          in the counts even though they're what the run is actually doing. */}
      {p.tasksRunning > 0 && (
        <span className="run-stat mono" title="Agent tasks currently executing">
          {p.tasksRunning} task{p.tasksRunning === 1 ? '' : 's'}
        </span>
      )}
      {p.waiting > 0 && <span className="run-stat run-stat-wait">{p.waiting} waiting</span>}
      {p.failed > 0 && <span className="run-stat run-stat-fail">{p.failed} failed</span>}
      <span className="run-stat mono" title="Elapsed">{formatElapsed(p.elapsedMs)}</span>

      <div className="toolbar-spacer" />

      {workspace && (
        <span className="run-ws mono" title={workspace}>
          {workspace.split(/[\\/]/).filter(Boolean).pop()}
        </span>
      )}
      <button className="ghost mini" onClick={onOpenFolder} title="Open this run's folder — every artifact as plain files">
        Open run folder
      </button>
      {workspace && (
        <button className="ghost mini" onClick={onOpenWorkspace} title="Open the bound project folder">
          Open workspace
        </button>
      )}
    </div>
  );
}
