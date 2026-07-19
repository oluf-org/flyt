// The Runs explorer: every run the project has produced, named by what it was
// asked to do, sectioned by when it happened, and renameable/deletable in place.
// A run's identity used to be its raw id — a 28-character timestamp that reads
// as noise in a list and tells you nothing about what the run *was*. The id is
// still the truth (it names the folder); it just isn't what the list leads with.
import { useEffect, useRef, useState } from 'react';
import { groupRuns, runStatus, runTimeLabel, runTimeTitle } from './runList.js';
import { sigil } from './sigil.js';

// Matched to the activity-rail icon set: 24-grid, currentColor stroke, 1.6.
const PENCIL = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" /><path d="M14.5 7.5 16.5 9.5" />
  </svg>
);
const TRASH = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 7h16" /><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.5 7 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3L17.5 7" />
  </svg>
);

export default function RunsList({ runs, activeRunId, onOpen, onRename, onDelete }) {
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef(null);
  const cancelled = useRef(false);

  // Sections are relative to `now`, so an app left open past midnight would keep
  // filing this morning's runs under "Yesterday". Re-render only when the
  // calendar day actually turns: returning `prev` unchanged makes React bail.
  useEffect(() => {
    const id = setInterval(() => setNow(prev =>
      new Date(prev).toDateString() === new Date().toDateString() ? prev : Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!editingId) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    // Select all — the existing name is a suggestion, so typing replaces it.
    // Selecting scrolls the field to the end of a long name, showing its tail
    // instead of the name you came to edit, so wind it back to the start.
    el.setSelectionRange(0, el.value.length, 'backward');
    el.scrollLeft = 0;
  }, [editingId]);

  const startEdit = (run, e) => {
    e.stopPropagation(); // renaming a run shouldn't also open it
    cancelled.current = false;
    setDraft(run.name);
    setEditingId(run.id);
  };

  const commit = async () => {
    const id = editingId;
    setEditingId(null);
    if (cancelled.current) { cancelled.current = false; return; }
    await onRename(id, draft);
  };

  const onEditKeyDown = e => {
    if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
    else if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur(); }
  };

  const remove = async (run, e) => {
    e.stopPropagation();
    if (!window.confirm(
      `Delete run "${run.name}"?\n\nIts folder — logs, plan, task and node outputs — is deleted for good.`
    )) return;
    await onDelete(run.id);
  };

  if (!runs.length) return <div className="explorer-list"><div className="muted">No runs yet.</div></div>;

  return (
    <div className="explorer-list run-explorer">
      {groupRuns(runs, now).map(group => (
        <section className="run-group" key={group.key}>
          <div className="run-group-label section-label">{group.label}</div>
          {group.runs.map(run => {
            const status = runStatus(run);
            const editing = editingId === run.id;
            const active = run.id === activeRunId;
            return (
              <div
                key={run.id}
                className={'run-row' + (active ? ' active' : '') + (editing ? ' editing' : '')}
                onClick={() => !editing && onOpen(run.id)}
                onKeyDown={e => {
                  if (editing) return;
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(run.id); }
                }}
                role="button"
                tabIndex={editing ? -1 : 0}
                aria-current={active ? 'true' : undefined}
                title={`${run.name}\n${runTimeTitle(run)} · ${status.label}\n${run.id}`}
              >
                <span
                  className={'run-sigil ' + status.kind}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: sigil(run.id, 22) }}
                />
                <div className="run-row-main">
                  {editing ? (
                    <input
                      ref={inputRef}
                      className="run-row-input"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={onEditKeyDown}
                      onBlur={commit}
                      onClick={e => e.stopPropagation()}
                      aria-label={`Rename run ${run.name}`}
                      maxLength={80}
                    />
                  ) : (
                    <div className="run-row-name">{run.name}</div>
                  )}
                  <div className="run-row-sub">
                    <span className="run-time mono">{runTimeLabel(run, now)}</span>
                    {run.flowName && <><span className="run-sep">·</span><span className="run-flow">{run.flowName}</span></>}
                    {run.turns > 0 && <><span className="run-sep">·</span><span className="run-turns" title="Follow-up turns">↩ {run.turns}</span></>}
                    {status.kind !== 'done' && <><span className="run-sep">·</span><span className={'run-status ' + status.kind}>{status.label}</span></>}
                  </div>
                </div>
                <div className="run-row-actions">
                  <button
                    className="row-action"
                    onClick={e => startEdit(run, e)}
                    title="Rename run"
                    aria-label={`Rename run ${run.name}`}
                    tabIndex={editing ? -1 : 0}
                  >{PENCIL}</button>
                  <button
                    className="row-action danger"
                    onClick={e => remove(run, e)}
                    title="Delete run"
                    aria-label={`Delete run ${run.name}`}
                    tabIndex={editing ? -1 : 0}
                  >{TRASH}</button>
                </div>
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
