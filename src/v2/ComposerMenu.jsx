import React, { useEffect, useRef, useState } from 'react';
import './composerMenu.css';

/**
 * A pill in the composer that opens a small popover above itself.
 *
 * Shared: the loop designer's change request (src/v2/ChangeRequestDialog.jsx)
 * and the chat window (src/chat/Chat.jsx) both render it, so its shape lives in
 * composerMenu.css beside this file rather than in either surface's stylesheet.
 *
 * A change request carries two things besides its words: what the AI may edit,
 * and which files it may read. Both used to sit above the box as native selects
 * and a disclosure — four lines of label, hint and placeholder text to state two
 * choices that are usually already right. A pill says the current value in one
 * line and keeps the alternatives out of sight until they are asked for.
 *
 * Real buttons rather than a listbox: the scope list mixes a kind of edit with a
 * particular step, and the other popover holds a textarea, so `role="option"`
 * would be a lie told to a screen reader. Buttons announce themselves and take
 * focus already; the trigger carries aria-haspopup/aria-expanded so the open
 * state is not a secret either.
 */
export default function ComposerMenu({ label, value, icon, tone = '', className = '', disabled, children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null), trigger = useRef(null), pop = useRef(null);

  const close = ({ focus = true } = {}) => { setOpen(false); if (focus) trigger.current?.focus(); };

  // Escape has to be caught before the dialog sees it, and cancelled outright:
  // stopping propagation alone still leaves Chromium's close request standing,
  // so dismissing the menu would dismiss the whole change request with it.
  useEffect(() => {
    if (!open) return;
    const away = event => { if (!root.current?.contains(event.target)) close({ focus: false }); };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key, true); };
  }, [open]);

  useEffect(() => { if (open) pop.current?.querySelector('button:not(:disabled), textarea')?.focus(); }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  // Up and down over the options — but not inside a text field, where the arrow
  // keys already mean something to the person pressing them.
  const arrows = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.closest('textarea, input')) return;
    const items = [...(pop.current?.querySelectorAll('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1) + items.length) % items.length]?.focus();
  };

  return <span className={`goal-menu ${className}`} ref={root} onKeyDown={arrows}>
    <button type="button" ref={trigger} className={`goal-menu-trigger ${tone}`} disabled={disabled}
      aria-haspopup="true" aria-expanded={open} aria-label={`${label}: ${value}`}
      onClick={() => (open ? close() : setOpen(true))}>
      {icon}<span className="goal-menu-value">{value}</span><span className="goal-menu-caret" aria-hidden="true"/>
    </button>
    {open && <div className="goal-menu-pop" ref={pop} role="group" aria-label={label}>{children(close)}</div>}
  </span>;
}

/** One clickable choice. The dot says which one you are on without a second column. */
export function MenuOption({ current, disabled, note, onClick, children }) {
  return <li>
    <button type="button" className="goal-menu-option" disabled={disabled} aria-current={current || undefined} onClick={onClick}>
      <span className="goal-menu-dot" aria-hidden="true"/>
      <span className="goal-menu-text">{children}</span>
      {note && <small>{note}</small>}
    </button>
  </li>;
}
