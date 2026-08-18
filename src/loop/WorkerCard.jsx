import React, { useEffect, useRef, useState } from 'react';
import LiveStream from '../LiveStream.jsx';
import { workerView, nowLine } from '../loopLive.js';
import { flightRow, humanDuration } from '../loopViewData.js';

// A worker in flight, watchable (LOOP-BOARD §C2/§C3).
//
// Collapsed, this is today's `flightRow` — glyph, id, stage, model, age, idle,
// interventions — which was already good, plus ONE new line: what it is doing
// right now. That line answers "is it thinking or is it working" for a person
// who does not want to expand anything, which is most people most of the time.
//
// Expanded, three tabs:
//   Output   — LiveStream verbatim. It already handles pinning, several streams
//              at once, and stick-to-bottom; a second implementation of that is
//              a second set of bugs.
//   Activity — tool calls, newest first, with ok/fail and duration.
//   Changes  — the files the worktree has, from work:diff.
//
// The snapshot arrives from the page's ONE shared `onRunUpdate` subscription,
// applied by runId. Three expanded cards subscribing separately would be three
// copies of the same buffer.

const HEALTH_GLYPH = { working: '◆', quiet: '◇', stalled: '▲', intervened: '⟳' };
const TABS = [['output', 'Output'], ['activity', 'Activity'], ['changes', 'Changes']];

// work:diff shells out to git. It is not free, and files-changed does not move
// token by token, so it gets its own slow timer and only while something is
// looking at it.
const DIFF_MS = 15_000;

export default function WorkerCard({
  heartbeat,
  snapshot = null,
  open = false,
  focused = false,
  busy = false,
  projectId,
  onToggle,
  onOpenRun = null,
  onMove = null
}) {
  const [tab, setTab] = useState('output');
  const [diff, setDiff] = useState(null);
  const [gates, setGates] = useState(null);
  const row = flightRow(heartbeat);
  const view = workerView(snapshot, heartbeat, { diff, gates });
  const now = nowLine(view);
  const timer = useRef(null);

  // Only while expanded, and only the slow one. Collapsing clears it, which is
  // what makes "collapse stops the work" true rather than aspirational.
  useEffect(() => {
    if (!open || !projectId || !heartbeat?.taskId) return undefined;
    let alive = true;
    const pull = () => {
      window.flyt?.workDiff?.(projectId, heartbeat.taskId)
        .then(d => { if (alive) setDiff(typeof d === 'string' ? d : d?.diff ?? null); })
        .catch(() => { if (alive) setDiff(null); });
    };
    pull();
    timer.current = setInterval(pull, DIFF_MS);
    return () => { alive = false; clearInterval(timer.current); };
  }, [open, projectId, heartbeat?.taskId]);

  // Gates are asked for once, on demand: `work:verify` runs the suite, so it is
  // a button and never a poll. A page that re-ran the tests every fifteen
  // seconds would be a page that never finished running the tests.
  const checkGates = async () => {
    setGates({ running: true });
    try { setGates(await window.flyt.workVerify(projectId, heartbeat.taskId)); }
    catch (err) { setGates({ ok: false, reason: String(err?.message ?? err), results: [] }); }
  };

  return (
    <article
      className={`loop-card worker health-${row.health}${open ? ' open' : ''}${focused ? ' focused' : ''}`}
      data-task={row.taskId}
    >
      <div className="loop-card-row">
        <button type="button" className="loop-card-head" aria-expanded={open} onClick={onToggle}>
          <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="glyph" title={row.health}>{HEALTH_GLYPH[row.health] ?? '◆'}</span>
          <span className="id mono">{row.taskId}</span>
          <span className="stage">{row.stage}</span>
          <span
            className="chip model"
            title={row.model ? 'the model this attempt is running on' : 'the effort band this attempt asked for'}
          >{row.model ?? row.level ?? ''}</span>
          <span className="age">{row.age}</span>
          <span className="idle" title="since anything last changed">idle {row.idle}</span>
        </button>
        {heartbeat?.runId && (
          <button type="button" className="link mono source-run" onClick={() => onOpenRun?.(heartbeat.runId)}>
            open run →
          </button>
        )}
      </div>

      {/* The one line that makes a collapsed row worth reading. */}
      {now && <p className="loop-card-line now"><span className="label">now</span> {now}</p>}

      {open && (
        <div className="loop-card-detail">
          {/* What the supervisor already tried, in the header of the expansion
              rather than crammed into the row: a stalled worker is exactly when
              you want to know it is already being handled. */}
          {view.stalled && (
            <div className="loop-worker-stalled">
              <strong>Nothing has changed for {humanDuration(view.idleMs)}.</strong>
              {view.interventions.length > 0
                ? <span> The supervisor has tried: {view.interventions.join(' → ')}.</span>
                : <span> The supervisor has not intervened yet.</span>}
            </div>
          )}

          {view.progress && (
            <p className="loop-worker-progress">
              {view.progress.done}/{view.progress.total} node(s) done
              {view.progress.tasksRunning ? ` · ${view.progress.tasksRunning} task(s) running` : ''}
              {view.progress.elapsedMs != null ? ` · ${humanDuration(view.progress.elapsedMs)} elapsed` : ''}
            </p>
          )}

          <div className="loop-tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id)}
              >
                {label}
                {id === 'activity' && view.toolCalls.length > 0 && <span className="count">{view.toolCalls.length}</span>}
                {id === 'changes' && view.files.length > 0 && <span className="count">{view.files.length}</span>}
              </button>
            ))}
          </div>

          {tab === 'output' && (
            snapshot
              ? <LiveStream snapshot={snapshot} />
              : <p className="empty">Fetching this run…</p>
          )}

          {tab === 'activity' && <Activity calls={view.toolCalls} />}

          {tab === 'changes' && (
            <Changes files={view.files} gates={view.gates} busy={busy} onCheckGates={checkGates} />
          )}

          {onMove && (
            <div className="loop-card-actions">
              <div className="row">
                <button disabled={busy} onClick={() => onMove({ action: 'release', command: 'task:release', to: 'queued' })}>
                  Release it
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

// A tool call's duration, in the unit that carries the information.
// `humanDuration` rounds to whole seconds, which is right for a task that has
// been running four minutes and wrong here: a 3ms read and an 800ms one both
// render as "0s", and the difference between them is the whole reason anyone
// reads this column.
const callMs = ms => (ms == null ? null : ms < 1000 ? `${ms}ms` : humanDuration(ms));

function Activity({ calls }) {
  if (!calls.length) return <p className="empty">No tool calls recorded yet.</p>;
  return (
    <ol className="loop-activity">
      {calls.map((c, i) => (
        <li key={`${c.name}-${i}`} className={c.ok ? 'ok' : 'failed'}>
          <span className="glyph" aria-hidden>{c.ok ? '✓' : '✕'}</span>
          <code className="mono name">{c.name}</code>
          {c.argsPreview && <span className="args mono">{c.argsPreview}</span>}
          {c.ms != null && <span className="ms">{callMs(c.ms)}</span>}
          {c.error && <span className="err">{c.error}</span>}
        </li>
      ))}
    </ol>
  );
}

function Changes({ files, gates, busy, onCheckGates }) {
  const [openFile, setOpenFile] = useState(null);
  return (
    <div className="loop-changes">
      {!files.length && <p className="empty">Nothing changed in the worktree yet.</p>}
      {files.map(f => (
        <div key={f.path} className="loop-file">
          <button type="button" className="loop-file-head" aria-expanded={openFile === f.path}
            onClick={() => setOpenFile(openFile === f.path ? null : f.path)}>
            <code className="mono">{f.path}</code>
            <span className="added">+{f.added}</span>
            <span className="removed">−{f.removed}</span>
          </button>
          {openFile === f.path && <pre className="loop-hunk">{f.hunk}</pre>}
        </div>
      ))}
      <div className="loop-gates">
        <button disabled={busy || gates?.running} onClick={onCheckGates}>
          {gates?.running ? 'Running the gates…' : 'Run the gates'}
        </button>
        {gates && !gates.running && (
          <div className={`loop-gate-result ${gates.ok ? 'ok' : 'failed'}`}>
            {gates.reason
              ? <p>{gates.reason}</p>
              : (gates.results ?? []).map(r => (
                <details key={r.command} open={r.status !== 'pass'}>
                  <summary>
                    <code className="mono">{r.command}</code> — {r.status}
                    {r.ms != null && <span className="ms"> {callMs(r.ms)}</span>}
                  </summary>
                  <pre>{r.output}</pre>
                </details>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
