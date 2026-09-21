import React, { useState } from 'react';
import Chat from '../chat/Chat.jsx';

// The Loop's chat (DECISIONS.md D45): a conversation attached to this project's
// backlog, that can answer questions about the queue and QUEUE WORK — without
// composing a flow.
//
// The window itself lives in src/chat/Chat.jsx and is shared with Build. What
// is left here is what is true only of the Loop: an enqueue_task proposal
// renders as a TASK CARD whose button calls `task:add`. The model proposes; the
// human commits. That is the highest-value interaction in the phase, and it is
// also the safety property — nothing here does the work, it only says what work
// there is.

export default function LoopChat({ projectId, activeModels = [], onOpenTask = null }) {
  return (
    <Chat
      channel="loop"
      projectId={projectId}
      activeModels={activeModels}
      renderProposal={proposal => (
        <Proposal proposal={proposal} projectId={projectId} onOpenTask={onOpenTask} />
      )}
    />
  );
}

// A task the model PROPOSED, shown before it exists. Chat turns call
// enqueue_task in propose mode, so unlike the old card this one is not already
// written when it appears: Queue it is the commit — `task:add` with the
// proposed body verbatim, landing on the exact id the proposal reserved — and
// Discard closes the card with nothing ever on disk.
function Proposal({ proposal, projectId, onOpenTask }) {
  const [state, setState] = useState('pending'); // pending | queued | discarded
  const [queueError, setQueueError] = useState(null);
  const queue = async () => {
    setQueueError(null);
    try {
      // The body the model proposed, committed by the one person who can. The
      // id goes in with it so the task lands on the id the card showed —
      // reserved at proposal time, claimed here (task:add, one door).
      const result = await window.flyt.addTask(projectId,
        proposal.task ?? { id: proposal.id, title: proposal.title, goal: proposal.goal });
      setState('queued');
      if (onOpenTask) onOpenTask(result?.id ?? proposal.id);
    } catch (err) { setQueueError(String(err?.message ?? err)); }
  };
  return (
    <div className={`flyt-chat-proposal${state !== 'pending' ? ` ${state}` : ''}`}>
      <div className="head">
        <span className="badge">{state === 'pending' ? 'proposed' : state}</span>
        <code className="mono">{proposal.id}</code>
        <strong>{proposal.title}</strong>
      </div>
      {proposal.goal && <p className="goal">{proposal.goal}</p>}
      {state === 'pending' && (
        <div className="flyt-chat-proposal-actions">
          <button type="button" className="primary" onClick={queue}>Queue it</button>
          <button type="button" className="link" onClick={() => setState('discarded')}>Discard</button>
        </div>
      )}
      {queueError && <p className="err">{queueError}</p>}
      {state === 'queued' && onOpenTask && proposal.id && (
        <button type="button" className="link" onClick={() => onOpenTask(proposal.id)}>Show it on the board</button>
      )}
    </div>
  );
}
