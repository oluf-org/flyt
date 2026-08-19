// The input gate (DECISIONS.md D27, D38, D46): a run parked with clarifying
// questions, answered inline.
//
// One component because there are now four places a run can be looked at, and
// a question you cannot answer from the surface you are standing on is a run
// that looks stuck. The chat and comparison views each grew their own copy of
// this markup; the RUNS page — the surface you land on when you open a run you
// did not start from the composer — grew none, so a headless or backgrounded
// run showed `awaiting_input` in its sidebar with nothing anywhere to type
// into. Found by driving the real app against a run parked on six questions.
//
// Two shapes, same content: `docked` is the card above a composer that will do
// the sending (chat, comparison), and `standalone` carries its own field and
// Send, for a surface with no composer of its own.
import { useState } from 'react';

// Candidate answers are chips rather than a select: they are a shortcut into
// the reply, not a control that decides anything, and picking several builds
// one answer. Appending — never replacing — is what makes that true.
function Question({ q, onPick }) {
  return (
    <li>
      <span className="input-gate-q">{q.text}</span>
      {q.why && <span className="input-gate-why">{q.why}</span>}
      {q.options?.length > 0 && (
        <span className="input-gate-options">
          {q.options.map((o, i) => (
            onPick
              ? <button key={i} type="button" className="input-gate-option" onClick={() => onPick(q, o)}>{o}</button>
              : <span key={i} className="input-gate-option is-static">{o}</span>
          ))}
        </span>
      )}
    </li>
  );
}

export default function InputGate({
  questions = [], askedBy = null, icon = '✍', hint = null,
  onPick = null, onAnswer = null, standalone = false
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // A chip has to land somewhere. Docked, the composer owns the text and the
  // parent takes the pick; standalone, this component owns both.
  const pick = onPick ?? ((q, o) =>
    setText(t => (t.trim() ? `${t.trimEnd()}\n${q.text} — ${o}` : `${q.text} — ${o}`)));

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try { await onAnswer?.(body); setText(''); }
    finally { setSending(false); }
  };

  return (
    <div className={'input-gate' + (standalone ? ' standalone' : '')} role="status">
      <div className="input-gate-head">
        <span className="input-gate-glyph" aria-hidden>{icon}</span>
        <strong>{askedBy ? `${askedBy} needs an answer to continue` : 'This run needs an answer to continue'}</strong>
      </div>
      <ol className="input-gate-questions">
        {questions.map((q, i) => <Question key={q.id ?? i} q={q} onPick={pick} />)}
      </ol>
      {standalone ? (
        <div className="input-gate-reply">
          <textarea
            className="chat-input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
            }}
            placeholder="One reply covering these is fine — ⌘/Ctrl+Enter to send."
            aria-label={`Answer the question from ${askedBy ?? 'this run'}`}
            rows={3}
          />
          <button className="primary" onClick={send} disabled={!text.trim() || sending}>
            {sending ? 'Sending…' : 'Answer'}
          </button>
        </div>
      ) : (
        <span className="input-gate-hint">
          {hint ?? 'One reply covering these is fine — the run picks up right after.'}
        </span>
      )}
    </div>
  );
}
