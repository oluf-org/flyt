import React, { useEffect, useRef, useState } from 'react';
import Chat from '../chat/Chat.jsx';

// Build's chat, over the canvas.
//
// Two things in the room: the title, and the box you type into. What is behind
// is pushed out of focus rather than covered over, so the workflow you are
// describing stays visible underneath the words describing it — the same shape
// the loop designer opens in (src/v2/ChangeRequestDialog.jsx), because they are
// the same act and looking different would be the surprising part.
//
// A native <dialog>, so Escape, the backdrop and focus containment are the
// platform's rather than three listeners of ours. The window inside is
// src/chat/Chat.jsx, the one the Loop drawer renders. What is Build's alone is
// in this file: a proposed change renders as a card whose Apply runs the
// model's `stack:` commands through `ctx.commands` — the one edit path
// (CLAUDE.md), the same door a drag on the canvas goes through.

export default function BuildChat({
  projectId, stack = null, activeModels = [], commands = null, onClose,
}) {
  const ref = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return undefined;
    opener.current = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="flyt-chat-dialog"
      aria-labelledby="build-chat-title"
      onMouseDown={event => { if (event.target === ref.current) onClose?.(); }}
      onCancel={event => { event.preventDefault(); onClose?.(); }}
    >
      <header>
        <h2 id="build-chat-title">Change this <span>{stack?.name ?? 'workflow'}</span></h2>
        <button type="button" aria-label="Close chat" onClick={() => onClose?.()}>×</button>
      </header>
      <Chat
        channel="build"
        projectId={projectId}
        activeModels={activeModels}
        autoFocus
        renderProposal={proposal => <ChangeProposal proposal={proposal} commands={commands} />}
      />
    </dialog>
  );
}

/**
 * A change the model PROPOSED, before anything is edited.
 *
 * Apply runs each command through `ctx.commands` in order, recorded as
 * `agent` — the model composed these arguments, and a history that logged them
 * as human edits would hide exactly the edits worth being able to find later.
 * What the human did is approve them, and the approval is why they exist.
 *
 * A command that refuses stops the rest: half an applied proposal is a workflow
 * in a state nobody designed, and the refusal is more useful than the remainder.
 */
function ChangeProposal({ proposal, commands }) {
  const [state, setState] = useState('pending'); // pending | applied | discarded
  const [error, setError] = useState(null);
  const steps = proposal.commands ?? [];
  const apply = async () => {
    if (!commands?.invoke) { setError('This host has no command surface, so nothing can be applied.'); return; }
    setError(null);
    try {
      for (const step of steps) await commands.invoke(step.name, step.args ?? {}, 'agent');
      setState('applied');
    } catch (err) { setError(String(err?.message ?? err)); }
  };
  return (
    <div className={`flyt-chat-proposal${state !== 'pending' ? ` ${state}` : ''}`}>
      <div className="head">
        <span className="badge">{state === 'pending' ? 'proposed' : state}</span>
        <strong>{proposal.summary ?? proposal.title ?? 'A change to this workflow'}</strong>
      </div>
      {/* Every command, named. A proposal you cannot read before pressing
          Apply is a proposal you are not really approving. */}
      {steps.length > 0 && (
        <ul className="flyt-chat-commands">
          {steps.map((step, index) => (
            <li key={`${step.name}-${index}`}>
              <code className="mono">{step.name}</code>
              <span>{step.args?.nodeId ?? step.args?.block?.id ?? step.args?.id ?? ''}</span>
            </li>
          ))}
        </ul>
      )}
      {state === 'pending' && (
        <div className="flyt-chat-proposal-actions">
          <button type="button" className="primary" disabled={!steps.length} onClick={apply}>
            Apply {steps.length === 1 ? 'it' : `${steps.length} edits`}
          </button>
          <button type="button" className="link" onClick={() => setState('discarded')}>Discard</button>
        </div>
      )}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
