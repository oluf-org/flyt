import React from 'react';

// One blocker, as a sentence with a button (DECISIONS.md D45).
//
// Deliberately not a badge. A badge means "go and look this up somewhere else",
// and the whole argument of Phase B is that the sentence has already been
// computed — core/blockers.js wrote it, the supervisor's headline uses the same
// words, so there is nothing left to look up. Print it.
//
// The remedy is the other half. A diagnosis with no action is a page that tells
// you your queue is broken and then makes you go and fix it in a text editor,
// which is what this replaces.

const GLYPH = { blocked: '■', warning: '▲' };

export default function BlockerNote({ blocker, busy = false, onRemedy = null, onOpenTask = null }) {
  if (!blocker) return null;
  const { kind, severity, summary, detail, subjects = [], remedy } = blocker;
  return (
    <div className={`loop-blocker sev-${severity}`} data-kind={kind}>
      <span className="glyph" aria-hidden>{GLYPH[severity] ?? '■'}</span>
      <div className="body">
        <p className="summary">{summary}</p>
        {/* The specifics, one sentence further down. Two sentences is the most
            a card can carry; the third belongs in the expanded view. */}
        {detail && <p className="detail">{detail}</p>}
        {/* What the sentence points at, clickable where it is a task. Naming
            t-0006 and giving no way to open it is the small cruelty that turns
            a diagnosis into a scavenger hunt. */}
        {subjects.length > 0 && onOpenTask && subjects.some(isTaskId) && (
          <p className="subjects">
            {subjects.filter(isTaskId).map(id => (
              <button key={id} type="button" className="link mono" onClick={() => onOpenTask(id)}>{id}</button>
            ))}
          </p>
        )}
      </div>
      {remedy && onRemedy && (
        <button
          type="button"
          className="loop-remedy"
          disabled={busy}
          aria-label={remedy.label}
          title={remedy.label}
          data-action={remedy.action}
          onClick={() => onRemedy(remedy)}
        >{remedy.label}</button>
      )}
    </div>
  );
}

const isTaskId = s => /^t-\d+$/.test(String(s));
