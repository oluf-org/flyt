import React, { useEffect, useRef, useState } from 'react';

// 24px stroke glyphs, matching ShellRail's set.
const icon = path => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
);
const PENCIL = icon(<><path d="M4 20h4L19 9a2 2 0 0 0-3-3L5 17z" /><path d="M14.5 6.5 17.5 9.5" /></>);
const TRASH = icon(<><path d="M4 7h16" /><path d="M9 7V5h6v2" /><path d="M6 7l1 12h10l1-12" /></>);

/**
 * Which Goal you are looking at, and what you can do to the ones you are not.
 *
 * This was a native `<select>`. The trigger could be styled and the popup could
 * not — the list that dropped out of it was the operating system's, several
 * flat rows of "My goal" with no way to tell them apart and nothing to do about
 * it. Renaming a draft meant opening it, finding the name field and saving; and
 * a draft, once made, could not be deleted at all, so the list only ever grew.
 *
 * A popup of real buttons rather than a listbox of options with controls
 * smuggled inside them: a row that carries a rename and a delete is not one
 * option, and `role="option"` would be a lie told to a screen reader. Buttons
 * already announce themselves, already take focus and already work with the
 * keyboard, and the trigger says `aria-haspopup`/`aria-expanded` so the state
 * is not a secret either.
 */
export default function GoalPicker({ draft, goals = [], drafts = [], busy, onOpen, onRename, onDelete }) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(null);   // draft id being renamed
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(null); // draft id awaiting a second click
  const root = useRef(null), trigger = useRef(null), first = useRef(null), field = useRef(null);

  const current = draft?.goalId
    ? (goals.find(item => item.id === draft.goalId)?.name ?? draft.definition?.name)
    : draft?.definition?.name;
  const label = current || (draft ? 'Unsaved instance' : 'Open a goal');

  const close = ({ focus = true } = {}) => {
    setOpen(false); setRenaming(null); setConfirming(null);
    if (focus) trigger.current?.focus();
  };

  // Anything that is not a deliberate action inside the popup closes it. A
  // half-typed rename is dropped rather than saved: losing a word beats
  // renaming something because a click landed somewhere else.
  useEffect(() => {
    if (!open) return;
    const away = event => { if (!root.current?.contains(event.target)) close({ focus: false }); };
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true); };
  }, [open]);

  useEffect(() => { if (open && !renaming) first.current?.focus(); }, [open]);
  useEffect(() => { if (renaming) { field.current?.focus(); field.current?.select(); } }, [renaming]);

  // Up and down over every focusable control in the popup, so the keyboard
  // reaches the rename and delete buttons rather than only the names.
  const arrows = event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...root.current.querySelectorAll('.goal-picker-menu button:not(:disabled), .goal-picker-menu input')];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length]?.focus();
  };

  const commitRename = id => {
    const value = name.trim();
    setRenaming(null);
    if (value && value !== drafts.find(item => item.id === id)?.name) onRename(id, value);
  };

  const row = (item, kind) => {
    const active = kind === 'draft' ? draft?.id === item.id && !draft?.goalId : draft?.goalId === item.id;
    if (renaming === item.id) {
      return (
        <li key={item.id} className="goal-picker-row renaming">
          <input ref={field} value={name} aria-label={`Rename ${item.name}`} maxLength={120}
            onChange={event => setName(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); commitRename(item.id); }
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setRenaming(null); }
            }} />
          <button className="goal-picker-confirm" onClick={() => commitRename(item.id)}>Save</button>
          <button onClick={() => setRenaming(null)}>Cancel</button>
        </li>
      );
    }
    if (confirming === item.id) {
      return (
        <li key={item.id} className="goal-picker-row confirming">
          <span className="goal-picker-ask">Delete “{item.name}”?</span>
          <button className="goal-picker-danger" onClick={() => { setConfirming(null); onDelete(item.id); }}>Delete</button>
          <button onClick={() => setConfirming(null)}>Cancel</button>
        </li>
      );
    }
    return (
      <li key={item.id} className="goal-picker-row">
        <button ref={node => { if (!first.current) first.current = node; }} className="goal-picker-name" data-id={item.id}
          aria-current={active || undefined} disabled={busy}
          onClick={() => { close({ focus: false }); onOpen(kind === 'goal' ? item.id : null, kind === 'draft' ? item.id : null); }}>
          <span className="goal-picker-dot" aria-hidden="true" />
          <span className="goal-picker-text">{item.name || 'Untitled'}</span>
          {kind === 'draft' && <small>draft</small>}
        </button>
        {/* Started Goals carry a contract, a history and the revision they are
            running: the authoring record has no second copy, and the backend
            refuses both of these on one. Offering buttons that always fail is
            worse than not offering them. */}
        {kind === 'draft' && (
          <span className="goal-picker-tools">
            <button className="goal-picker-tool" title={`Rename ${item.name}`} aria-label={`Rename ${item.name}`}
              disabled={busy} onClick={() => { setConfirming(null); setName(item.name || ''); setRenaming(item.id); }}>{PENCIL}</button>
            <button className="goal-picker-tool danger" title={`Delete ${item.name}`} aria-label={`Delete ${item.name}`}
              disabled={busy} onClick={() => { setRenaming(null); setConfirming(item.id); }}>{TRASH}</button>
          </span>
        )}
      </li>
    );
  };

  first.current = null;
  return (
    <span className="goal-picker" ref={root} onKeyDown={arrows}>
      <button ref={trigger} type="button" className="goal-picker-trigger" disabled={busy}
        aria-haspopup="true" aria-expanded={open} aria-label="Saved goals"
        onClick={() => (open ? close() : setOpen(true))}>
        <span className="goal-picker-label">{label}</span>
        <span className="goal-picker-caret" aria-hidden="true" />
      </button>
      {open && (
        <div className="goal-picker-menu" role="group" aria-label="Saved goals">
          {!drafts.length && !goals.length && <p className="goal-picker-empty">Nothing saved yet.</p>}
          {drafts.length > 0 && <><p className="goal-picker-group">Drafts</p><ul>{drafts.map(item => row(item, 'draft'))}</ul></>}
          {goals.length > 0 && <><p className="goal-picker-group">Goals</p><ul>{goals.map(item => row(item, 'goal'))}</ul></>}
        </div>
      )}
    </span>
  );
}
