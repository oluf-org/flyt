import React, { useEffect, useRef, useState } from 'react';
import { runProgress, formatElapsed } from './runProgress.js';
import { sigil } from './sigil.js';
import Tip from './Tip.jsx';

// The run view's header (V1 task 9). D4 makes the canvas the live transparency
// view of execution; this is the frame around it that answers "how far along is
// this, is it still moving, and how do I get to the files?" — none of which the
// canvas can say without the user counting glyphs.
//
// While the run is live it also carries the run controls (RUN-CONTROL): pause /
// resume and a two-click stop, mirrored by the canvas's right-click menu.
export default function RunBar({ snapshot, onOpenFolder, onOpenWorkspace, docView, onDocView, onPause, onResume, onStop }) {
  const [now, setNow] = useState(() => Date.now());
  const p = runProgress(snapshot, now);
  const live = Boolean(p?.live);
  const paused = Boolean(snapshot.meta?.paused);
  const branchedFrom = snapshot.meta?.branchedFrom ?? null;

  // Stop is the one destructive action: the first click re-arms the button
  // for three seconds instead of opening a dialog (same rule as the menu).
  const [confirmStop, setConfirmStop] = useState(false);
  const confirmTimer = useRef(null);
  useEffect(() => () => clearTimeout(confirmTimer.current), []);
  const clickStop = () => {
    if (confirmStop) {
      clearTimeout(confirmTimer.current);
      setConfirmStop(false);
      onStop?.();
      return;
    }
    setConfirmStop(true);
    confirmTimer.current = setTimeout(() => setConfirmStop(false), 3000);
  };

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
      {snapshot.meta?.runId && (
        <span
          className="run-bar-sigil"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: sigil(snapshot.meta.runId, 24) }}
        />
      )}
      <span className="run-bar-name" title={snapshot.meta?.flowName}>
        {snapshot.meta?.flowName ?? 'Run'}
      </span>
      {branchedFrom && (
        <Tip as="span" className="run-chip-branch" text="Branched from a previous run">⑂ branch</Tip>
      )}

      <div
        className="run-meter"
        role="progressbar"
        aria-valuenow={p.done}
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-label="Nodes completed"
        title={`${p.done} of ${p.total} nodes done`}
      >
        <span className={'run-meter-fill' + (paused ? ' paused' : '')} style={{ width: `${pct}%` }} />
        {p.failed > 0 && <span className="run-meter-fail" style={{ width: `${failPct}%` }} />}
      </div>

      <span className="run-stat mono">{p.done}/{p.total}</span>
      {paused && <span className="run-chip-paused">Paused</span>}
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

      {live && onStop && (
        <div className="run-controls">
          {paused ? (
            <Tip as="button" type="button" className="run-ctl" text="Resume the run" onClick={onResume}>▶</Tip>
          ) : (
            <Tip as="button" type="button" className="run-ctl" text="Pause after the current step" onClick={onPause}>❚❚</Tip>
          )}
          <Tip
            as="button"
            type="button"
            className={'run-ctl danger' + (confirmStop ? ' confirm' : '')}
            text={confirmStop ? 'Click again to confirm stop' : 'Stop the run — finished work is kept'}
            onClick={clickStop}
          >■</Tip>
        </div>
      )}

      {onDocView && (
        <div className="view-switch" role="tablist" aria-label="Run view">
          <button
            type="button" role="tab" aria-selected={docView !== 'document'}
            className={'view-btn' + (docView !== 'document' ? ' active' : '')}
            onClick={() => onDocView('canvas')}
          ><span className="view-btn-glyph">◇</span> Canvas</button>
          <button
            type="button" role="tab" aria-selected={docView === 'document'}
            className={'view-btn' + (docView === 'document' ? ' active' : '')}
            onClick={() => onDocView('document')}
          ><span className="view-btn-glyph">▤</span> Document</button>
        </div>
      )}

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
