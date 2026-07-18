import React, { useState } from 'react';
import { isTerminal } from './runProgress.js';
import { outputKey } from './runGraph.js';

// What the run actually produced, surfaced the moment it finishes (V1 task 9).
// It takes the slot the live panel vacates: while working you watch tokens,
// when finished you read the outcome. Reads the snapshot the renderer already
// has — the Output node writes the same markdown to nodes/<id>.md and result.md
// — so no new IPC and no opening the run folder to find out what happened.
//
// A finished run is also a conversation (FOLLOWUP-PLAN): each follow-up turn
// renders as a thread segment (feedback -> outcome), and the composer at the
// bottom sends the next one. The composer only exists at terminal stages —
// while a turn runs the run is live, this panel yields to the live stream, and
// one-turn-at-a-time (FU10) holds by construction.

const CLASS_LABEL = { question: 'Question', fix: 'Fix', feature: 'Feature' };

function TurnSegment({ turn, snapshot }) {
  const triage = turn.triage ?? null;
  const review = snapshot.nodeOutputs?.[outputKey(`fu${turn.turn}-review`)];
  const outcome = turn.answer ?? review;
  return (
    <div className="fu-turn">
      <div className="fu-feedback">
        <span className="fu-turn-num mono">{turn.turn}</span>
        <pre className="fu-feedback-text">{turn.prompt ?? '(no prompt recorded)'}</pre>
      </div>
      {triage?.class && (
        <div className="fu-triage">
          <span className={`fu-class fu-class-${triage.class}`}>{CLASS_LABEL[triage.class] ?? triage.class}</span>
          {triage.reason && <span className="fu-reason">{triage.reason}</span>}
        </div>
      )}
      {outcome
        ? <pre className="result-body">{outcome}</pre>
        : <pre className="result-body result-empty">This turn produced no review output yet — its nodes are on the canvas.</pre>}
    </div>
  );
}

function Composer({ stage, onFollowUp }) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  if (!onFollowUp) return null;

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await onFollowUp(text);
      setDraft('');
    } catch (err) {
      // The engine refuses with the whole reason (still live, no flow.json…);
      // show it rather than the IPC wrapper around it.
      window.alert(String(err?.message ?? err)
        .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
    } finally {
      setSending(false);
    }
  };

  const placeholder = stage === 'done'
    ? 'Reply to this result — ask, request a fix, or add a feature…'
    : stage === 'failed'
      ? 'Tell the run how to continue — “skip that step”, “use approach B”…'
      : 'Say what was wrong — the run continues from your reply…';

  return (
    <div className="fu-composer">
      <textarea
        value={draft}
        placeholder={placeholder}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}
        aria-label="Follow-up message"
      />
      <button className="primary" onClick={send} disabled={sending || !draft.trim()}>
        {sending ? 'Sending…' : 'Send'}<kbd className="shortcut">⌘↵</kbd>
      </button>
    </div>
  );
}

export default function RunResult({ snapshot, onFollowUp }) {
  const meta = snapshot?.meta;
  if (!meta || !isTerminal(meta.stage)) return null;

  const followups = snapshot.followups ?? [];
  const thread = followups.length > 0 && (
    <div className="fu-thread">
      {followups.map(t => <TurnSegment key={t.turn} turn={t} snapshot={snapshot} />)}
    </div>
  );
  const composer = <Composer stage={meta.stage} onFollowUp={onFollowUp} />;

  if (meta.stage === 'failed' || meta.stage === 'rejected') {
    const failed = meta.stage === 'failed';
    return (
      <section className="result-panel" aria-label="Run outcome">
        <div className="result-head">
          <span className={'result-badge' + (failed ? ' bad' : '')}>{failed ? 'Failed' : 'Rejected'}</span>
        </div>
        <pre className="result-body">
          {meta.error || (failed
            ? 'The run stopped. Open the run folder and read log.jsonl for the full trace.'
            : 'You rejected this run at an approval gate; nothing further ran.')}
        </pre>
        {thread}
        {composer}
      </section>
    );
  }

  // A flow can declare more than one Output node; show each, labelled only when
  // there is a choice to disambiguate.
  const outputs = (snapshot.flow?.nodes ?? [])
    .filter(n => n.type === 'output')
    .map(n => ({ id: n.id, text: snapshot.nodeOutputs?.[outputKey(n.id)] }))
    .filter(o => o.text);

  return (
    <section className="result-panel" aria-label="Run result">
      <div className="result-head">
        <span className="result-badge">Done</span>
        <span className="section-label">Result</span>
      </div>
      {outputs.length
        ? outputs.map(o => (
          <div key={o.id}>
            {outputs.length > 1 && <span className="result-sub mono">{o.id}</span>}
            <pre className="result-body">{o.text}</pre>
          </div>
        ))
        : <pre className="result-body result-empty">
            This flow has no Output node, so it produced no collected result.
            Per-node outputs are on the canvas and in the run folder.
          </pre>}
      {thread}
      {composer}
    </section>
  );
}
