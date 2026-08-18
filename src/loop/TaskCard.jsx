import React, { useState } from 'react';
import { taskDetail } from '../loopViewData.js';
import { allowedMoves } from '../loopBoardData.js';
import BlockerNote from './BlockerNote.jsx';
import { LEVELS } from './ModelBands.jsx';

// One task on the board (LOOP-BOARD §D3).
//
// Collapsed it is one line high: id · title · level · attempts · value/effort ·
// where it came from · and the blocker SENTENCE if there is one. Expanded it
// keeps everything `taskDetail()` already showed — that projection is good and
// is not rewritten — and adds the three things that make this a working surface
// rather than a dashboard:
//
//   the blockers, each with the button that clears it;
//   the attempt history, which is how you notice a task being re-rolled at
//     increasing expense;
//   inline editing of the fields that unblock things, because fixing a task's
//     gates is the single most common unblocking action and today it means
//     opening a file in an editor.
//
// Editing is refused on a task a worker holds. core/backlog.js `update()` is a
// read-modify-write, so two writers to one file silently lose a field — that is
// a real race and pretending otherwise would cost someone a task.

export default function TaskCard({
  card,
  task,
  open = false,
  focused = false,
  busy = false,
  spend = null,
  removeState = null,          // 'ask' | 'force' | null
  nextUp = false,
  onToggle,
  onOpenRun = null,
  onOpenTask = null,
  onMove,
  onRemedy = null,
  onAnswer = null
}) {
  const detail = open ? taskDetail(task ?? {}, { spend }) : null;
  const moves = allowedMoves(task ?? card, { blockers: card.blockers ?? [] });
  const canEdit = moves.some(m => m.action === 'edit');

  return (
    <article
      className={[
        'loop-card',
        open ? 'open' : '',
        focused ? 'focused' : '',
        card.blocked ? 'blocked' : '',
        card.question ? 'asking' : '',
        card.unreadable ? 'unreadable' : '',
        nextUp ? 'next-up' : ''
      ].filter(Boolean).join(' ')}
      data-task={card.id}
    >
      {/* One row, two controls: the head expands, the source link navigates.
          Siblings rather than nested, because a button inside a button is
          neither valid nor clickable. */}
      <div className="loop-card-row">
        <button type="button" className="loop-card-head" aria-expanded={open} onClick={onToggle}>
          <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="id mono">{card.id}</span>
          {/* `title` on the element as well as in it: a 215px column will elide
              a long one, and the tooltip is the only way to read the rest. */}
          <span className="title" title={card.title || undefined}>
            {card.title || (card.unreadable ? card.error : '')}
          </span>
          {/* What the loop will actually take next. A mark on the card rather
              than a label between cards, which reads as belonging to whichever
              one your eye reached first. */}
          {nextUp && <span className="next-up-mark">next</span>}
          {card.level && <span className="chip level">{card.level}</span>}
          {card.attempts > 0 && <span className="chip attempts" title="attempts so far">{card.attempts}×</span>}
          {card.value != null && card.effort != null && (
            <span className="chip ratio" title="what it is worth, over what it costs">
              {card.value}/{card.effort}
            </span>
          )}
        </button>
        {card.sourceRunId && (
          <button
            type="button"
            className="link mono source-run"
            title={`Queued by the "${card.sourceNodeId ?? 'loop'}" node of run ${card.sourceRunId}`}
            onClick={() => onOpenRun?.(card.sourceRunId)}
          >← {card.sourceNodeId ?? 'flow'}</button>
        )}
      </div>

      {/* The blocker as a sentence, on the collapsed card. This is the line
          that used to require opening a file to obtain. */}
      {!open && card.line && (
        <p className={`loop-card-line${card.question ? ' question' : ''}`}>{card.line}</p>
      )}

      {/* A question an agent asked, with somewhere to answer it. The single
          highest-value control on this page: an ambiguity that used to burn a
          task's whole attempt ladder is now a sentence and a reply. */}
      {card.question && onAnswer && <AnswerBox card={card} busy={busy} onAnswer={onAnswer} />}

      {open && detail && (
        <div className="loop-card-detail">
          {(card.blockers ?? []).length > 0 && (
            <div className="loop-card-blockers">
              {card.blockers.map((b, i) => (
                <BlockerNote key={`${b.kind}-${i}`} blocker={b} busy={busy} onRemedy={onRemedy} onOpenTask={onOpenTask} />
              ))}
            </div>
          )}

          {detail.facts.length > 0 && (
            <dl className="loop-card-facts">
              {detail.facts.map(f => (
                <div key={f.label} title={f.title}>
                  <dt>{f.label}</dt><dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}

          {canEdit
            ? <InlineEdit task={task ?? {}} busy={busy} onMove={onMove} />
            : detail.lists.map(l => (
              <div key={l.key} className="loop-card-list">
                <span className="label">{l.label}</span>
                {l.items.map(item => <code key={item} className="mono">{item}</code>)}
              </div>
            ))}

          {/* Attempt history: the thing that tells you a task is being
              re-rolled at increasing expense. One line per run. */}
          {detail.runIds.length > 0 && (
            <div className="loop-card-list">
              <span className="label">Attempts</span>
              {detail.runIds.map((id, i) => (
                <button key={id} type="button" className="link mono" onClick={() => onOpenRun?.(id)}>
                  #{i + 1} {id}
                </button>
              ))}
            </div>
          )}

          {detail.body && <pre className="loop-card-body">{detail.body}</pre>}
          {detail.empty && !card.blockers?.length && <p className="empty">Nothing recorded beyond the title.</p>}
        </div>
      )}

      <div className="loop-card-actions">
        <div className="row">
          {moves.filter(m => m.action !== 'edit' && !m.remedy).map(move => (
            move.action === 'remove'
              ? <RemoveControl key="remove" move={move} state={removeState} busy={busy} onMove={onMove} />
              : (
                <button key={move.action} disabled={busy} onClick={() => onMove(move)}>{move.label}</button>
              )
          ))}
        </div>
      </div>
    </article>
  );
}

/**
 * Remove: one press to ask, one to mean it.
 *
 * Kept exactly as it was in the stacked-pile version, including the narrower
 * second state — a task a worker holds is REFUSED by the backlog on the first
 * press, and the honest answer is not to hide the button but to say what is in
 * the way and let the second press mean it.
 */
function RemoveControl({ move, state, busy, onMove }) {
  if (!state) {
    return (
      <button
        className="link loop-remove"
        disabled={busy}
        title="Delete this task from the backlog"
        onClick={() => onMove({ ...move, phase: 'ask' })}
      >Remove</button>
    );
  }
  const forced = state === 'force';
  return (
    <span className="loop-remove-confirm">
      <span className="ask">{forced ? 'Still remove it?' : 'Remove for good?'}</span>
      <button className="reject" disabled={busy} onClick={() => onMove({ ...move, phase: 'confirm', force: forced })}>
        {forced ? 'Remove anyway' : 'Remove'}
      </button>
      <button className="link" disabled={busy} onClick={() => onMove({ ...move, phase: 'cancel' })}>Cancel</button>
    </span>
  );
}

/**
 * The fields worth fixing from here, edited in place.
 *
 * Save on blur, optimistic, and the error surfaces on the page rather than
 * silently reverting — a field that snaps back with no explanation is how a
 * person learns not to trust an input.
 */
function InlineEdit({ task, busy, onMove }) {
  const save = (field, value) => onMove({ action: 'edit', command: 'task:update', patch: { [field]: value } });
  return (
    <div className="loop-card-edit">
      <label>
        <span>Effort band</span>
        <select
          defaultValue={task.level ?? ''}
          disabled={busy}
          onChange={e => save('level', e.target.value || null)}
        >
          <option value="">project default</option>
          {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </label>
      <label>
        <span>Value</span>
        <input type="number" min="1" max="5" defaultValue={task.value ?? 3} disabled={busy}
          onBlur={e => save('value', Number(e.target.value))} />
      </label>
      <label>
        <span>Effort</span>
        <input type="number" min="1" max="5" defaultValue={task.effort ?? 3} disabled={busy}
          onBlur={e => save('effort', Number(e.target.value))} />
      </label>
      <label className="wide">
        <span>Depends on</span>
        <input type="text" defaultValue={(task.dependsOn ?? []).join(', ')} placeholder="t-0006, t-0007" disabled={busy}
          onBlur={e => save('dependsOn', splitList(e.target.value))} />
      </label>
      <label className="wide">
        {/* The most common unblocking action there is: a task that declares a
            gate this machine cannot run is unlandable however good the work. */}
        <span>Extra gates</span>
        <input type="text" defaultValue={(task.gates ?? []).join(', ')} placeholder="npm test" disabled={busy}
          onBlur={e => save('gates', splitList(e.target.value))} />
      </label>
      <label className="wide">
        <span>Blast radius</span>
        <input type="text" defaultValue={(task.blastRadius ?? []).join(', ')} placeholder="src/loop/Board.jsx" disabled={busy}
          onBlur={e => save('blastRadius', splitList(e.target.value))} />
      </label>
    </div>
  );
}

const splitList = v => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean);

/**
 * Answering a question an agent asked (`ask_human`, LOOP-BOARD §A6).
 *
 * The answer goes into the task body and the task requeues, so the next attempt
 * starts with the answer that the last three attempts were guessing at. Options
 * are buttons where the agent offered them, because a click beats an essay.
 */
function AnswerBox({ card, busy, onAnswer }) {
  const [text, setText] = useState('');
  const send = value => {
    const answer = String(value ?? text).trim();
    if (!answer) return;
    setText('');
    onAnswer(card.id, answer);
  };
  return (
    <div className="loop-answer">
      {card.question.context && <p className="context">{card.question.context}</p>}
      {card.question.options.length > 0 && (
        <div className="options">
          {card.question.options.map(o => (
            <button key={o} type="button" disabled={busy} onClick={() => send(o)}>{o}</button>
          ))}
        </div>
      )}
      <form onSubmit={e => { e.preventDefault(); send(); }}>
        <input
          type="text"
          value={text}
          placeholder="Answer, and it goes back in the queue"
          disabled={busy}
          onChange={e => setText(e.target.value)}
        />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>Answer</button>
      </form>
    </div>
  );
}
