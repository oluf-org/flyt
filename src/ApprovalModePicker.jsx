import React, { useEffect, useRef, useState } from 'react';

// The approval-mode chip that sits under the run composer (APPROVAL-MODES §3).
//
// It is one line of chrome by design: the run panel is already dense, and this
// is a setting you glance at rather than operate. Collapsed it shows an icon and
// the mode's short name; the three options live in a popover, each with the one
// sentence that actually distinguishes it.
//
// 'always' is styled as a warning — amber text, a warning glyph, and a
// persistent one-line caption under the chip — because it is the only mode in
// which a shell command reaches the user's real project folder with nobody
// watching, and the cost of not noticing you left it on is unbounded.

export const APPROVAL_MODE_OPTIONS = [
  {
    id: 'ask',
    label: 'Ask permission',
    glyph: '◎',
    blurb: 'Pause before every file write and shell command.',
    detail: 'The safe default. Nothing touches your project until you approve it.'
  },
  {
    id: 'smart',
    label: 'Smart approval',
    glyph: '◈',
    blurb: 'Check each command first, ask only when it looks risky.',
    detail: 'Routine reads, tests and in-project writes run straight through. Anything destructive, remote, or outside the project stops for you.'
  },
  {
    id: 'always',
    label: 'Always approve',
    glyph: '⚠',
    danger: true,
    blurb: 'Run everything unattended, with no approval at all.',
    detail: 'The agent can delete files, rewrite git history and run any shell command in your project without asking. Use only on work you can throw away.'
  }
];

const byId = id => APPROVAL_MODE_OPTIONS.find(o => o.id === id) ?? APPROVAL_MODE_OPTIONS[0];

export default function ApprovalModePicker({ mode = 'ask', onChange, safetyModel = null }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const current = byId(mode);

  // Close on outside click or Escape — the popover is transient chrome, not a
  // dialog, so it should never need a deliberate dismissal.
  useEffect(() => {
    if (!open) return;
    const onDown = e => { if (!wrapRef.current?.contains(e.target)) setOpen(false); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const pick = id => { onChange?.(id); setOpen(false); };

  return (
    <div className="approval-mode" ref={wrapRef}>
      <button
        type="button"
        className={'approval-chip' + (current.danger ? ' danger' : '') + (open ? ' open' : '')}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${current.label} — ${current.blurb} Click to change.`}
      >
        <span className="approval-chip-glyph" aria-hidden>{current.glyph}</span>
        <span className="approval-chip-label">{current.label}</span>
        <span className="approval-chip-caret" aria-hidden>{open ? '▾' : '▴'}</span>
      </button>

      {/* Persistent, not just in the popover: the whole risk of "always approve"
          is forgetting it is on, so the warning outlives the interaction. */}
      {current.danger && !open && (
        <p className="approval-warning">Commands run unattended in this project.</p>
      )}
      {mode === 'smart' && !open && safetyModel && (
        <p className="approval-note">
          Screened by <span className="mono">{safetyModel}</span>
        </p>
      )}

      {open && (
        <div className="approval-pop" role="listbox" aria-label="Tool approval mode">
          {APPROVAL_MODE_OPTIONS.map(o => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === mode}
              className={'approval-opt' + (o.id === mode ? ' active' : '') + (o.danger ? ' danger' : '')}
              onClick={() => pick(o.id)}
            >
              <span className="approval-opt-glyph" aria-hidden>{o.glyph}</span>
              <span className="approval-opt-text">
                <span className="approval-opt-label">
                  {o.label}
                  {o.danger && <span className="approval-danger-tag">dangerous</span>}
                </span>
                <span className="approval-opt-blurb">{o.blurb}</span>
                <span className="approval-opt-detail">{o.detail}</span>
              </span>
              {o.id === mode && <span className="approval-opt-tick" aria-hidden>{'✓'}</span>}
            </button>
          ))}
          <p className="approval-pop-foot">
            Applies to the next run you start. Change the default and the safety model in Settings.
          </p>
        </div>
      )}
    </div>
  );
}
