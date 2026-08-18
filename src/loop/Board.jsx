import React from 'react';
import TaskCard from './TaskCard.jsx';
import WorkerCard from './WorkerCard.jsx';
import BlockerNote from './BlockerNote.jsx';

// The columns (LOOP-BOARD §D2).
//
// Layout only. Which column a task belongs to, what moves it has, what its
// blocker sentence says, where the keyboard cursor goes — all of that is
// src/loopBoardData.js, tested without a DOM. If this file starts computing
// something, that is the bug.
//
// The Working column is the one that is not simply a list of TaskCards: its
// cards are WorkerCards driven by the run snapshots the page holds, because a
// worker's card is about what it is doing rather than about what it says.

export default function Board({
  columns = [],
  banner = null,
  tasksById = new Map(),
  heartbeats = [],
  snapshots = new Map(),
  openId = null,
  cursor = null,
  busy = false,
  projectId,
  spend = {},
  removeState = null,
  showDone = false,
  onToggleDone,
  onToggle,
  onMove,
  onRemedy,
  onAnswer,
  onOpenRun,
  onOpenTask
}) {
  const beatFor = id => heartbeats.find(h => h.taskId === id) ?? null;

  return (
    <div className="loop-board">
      {banner && (
        <div className={`loop-banner sev-${banner.severity}`}>
          <BlockerNote blocker={banner} busy={busy} onRemedy={onRemedy} />
          {banner.others.length > 0 && (
            <details className="loop-banner-more">
              <summary>{banner.others.length} more</summary>
              {banner.others.map((b, i) => (
                <BlockerNote key={`${b.kind}-${i}`} blocker={b} busy={busy} onRemedy={onRemedy} />
              ))}
            </details>
          )}
        </div>
      )}

      <div className="loop-columns">
        {columns.map(col => (
          <section
            key={col.id}
            className={`loop-column loop-column-${col.id}`}
            aria-label={`${col.label}, ${col.count} task${col.count === 1 ? '' : 's'}`}
          >
            <h2>
              {col.label}
              <span className="count">{col.count}</span>
              {col.id === 'done' && (
                <button type="button" className="link" onClick={onToggleDone}>
                  {showDone ? 'hide' : 'show'}
                </button>
              )}
            </h2>

            {/* An empty column's text is written to be the answer, not a
                shrug: "Nothing is waiting on you" is good news, and reads as
                good news. */}
            {!col.count && <p className="empty">{col.emptyText}</p>}

            <div role="list" className="loop-column-cards">
              {col.cards.map(card => (
                <div role="listitem" key={card.id}>
                  {col.id === 'working' && beatFor(card.id)
                    ? (
                      <WorkerCard
                        heartbeat={beatFor(card.id)}
                        snapshot={snapshots.get(beatFor(card.id).runId)?.snapshot ?? null}
                        open={openId === card.id}
                        focused={cursor?.id === card.id}
                        busy={busy}
                        projectId={projectId}
                        onToggle={() => onToggle(card.id)}
                        onOpenRun={onOpenRun}
                        onMove={move => onMove(card.id, move)}
                      />
                    )
                    : (
                      <TaskCard
                        card={card}
                        task={tasksById.get(card.id) ?? card}
                        open={openId === card.id}
                        focused={cursor?.id === card.id}
                        busy={busy}
                        spend={spend[card.id] ?? null}
                        removeState={removeState?.id === card.id ? removeState.phase : null}
                        nextUp={col.nextUp === card.id}
                        onToggle={() => onToggle(card.id)}
                        onMove={move => onMove(card.id, move)}
                        onRemedy={remedy => onRemedy(remedy, card.id)}
                        onAnswer={onAnswer}
                        onOpenRun={onOpenRun}
                        onOpenTask={onOpenTask}
                      />
                    )}
                </div>
              ))}
            </div>

            {col.truncated > 0 && (
              <p className="loop-column-more">{col.truncated} more not shown</p>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
