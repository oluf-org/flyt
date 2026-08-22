import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ModelPicker } from '../ModelPicker.jsx';

// The chat drawer (DECISIONS.md D45): a conversation attached to this project's
// backlog, that can answer questions about the queue and QUEUE WORK — without
// composing a flow.
//
// Two things here are deliberate and easy to get wrong:
//
//   Tool calls render as one collapsed line each, never hidden. The trust model
//   of this whole app is that you can see what it did, and a chat that quietly
//   reads forty files is the first place that would stop being true.
//
//   An enqueue_task call renders as a TASK CARD, not as a line of prose. The
//   model proposes; the human commits. That is the highest-value interaction in
//   the phase, and it is also the safety property — nothing here does the work,
//   it only says what work there is.

export default function LoopChat({ projectId, activeModels = [], boardBlockers = [], onOpenTask = null }) {
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState('');
  const [liveCalls, setLiveCalls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [worker, setWorker] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const bodyRef = useRef(null);
  const stick = useRef(true);

  const loadThreads = useCallback(async () => {
    if (!projectId || !window.flyt?.chatThreads) return;
    try {
      const r = await window.flyt.chatThreads(projectId);
      setThreads(r?.threads ?? []);
    } catch (err) { setError(String(err?.message ?? err)); }
  }, [projectId]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // The model this person already chose, restored per install (E2).
  useEffect(() => {
    window.flyt?.getSettings?.()
      .then(s => setWorker(s?.chat?.worker ?? null))
      .catch(() => {});
  }, []);

  const openThread = useCallback(async id => {
    setThreadId(id);
    setStreaming('');
    setLiveCalls([]);
    if (!id) { setTurns([]); return; }
    try { setTurns((await window.flyt.chatRead(projectId, id))?.turns ?? []); }
    catch (err) { setError(String(err?.message ?? err)); }
  }, [projectId]);

  // Streaming tokens and tool calls, live. The persisted turn arrives when
  // `chatSend` resolves; this is only what happens BEFORE that write.
  useEffect(() => {
    if (!projectId || !window.flyt?.onChatEvent) return undefined;
    return window.flyt.onChatEvent(ev => {
      if (ev.projectId !== projectId || ev.threadId !== threadId) return;
      if (ev.kind === 'text') setStreaming(ev.text ?? '');
      else if (ev.kind === 'tool') setLiveCalls(prev => [...prev, ev]);
    });
  }, [projectId, threadId]);

  // Follow the tail, unless the reader has scrolled up.
  useEffect(() => {
    const el = bodyRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns.length, streaming, liveCalls.length]);

  const send = async () => {
    const question = text.trim();
    if (!question || busy) return;
    let id = threadId;
    if (!id) {
      id = (await window.flyt.chatNew(projectId))?.threadId;
      setThreadId(id);
    }
    setText('');
    setBusy(true);
    setError(null);
    setStreaming('');
    setLiveCalls([]);
    // Optimistic: the question appears the instant it is asked, because a
    // send button that does nothing visible for four seconds is a send button
    // people press twice.
    setTurns(prev => [...prev, { role: 'user', text: question, at: new Date().toISOString() }]);
    try {
      await window.flyt.chatSend(projectId, id, question, worker);
      setTurns((await window.flyt.chatRead(projectId, id))?.turns ?? []);
      await loadThreads();
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
      setStreaming('');
      setLiveCalls([]);
    }
  };

  const chooseModel = async w => {
    setWorker(w);
    try { await window.flyt.setSettings({ chat: { worker: w } }); }
    catch (err) { setError(String(err?.message ?? err)); }
  };

  const removeThread = async id => {
    if (pendingDelete !== id) { setPendingDelete(id); return; }
    setPendingDelete(null);
    try {
      await window.flyt.chatDelete(projectId, id);
      if (threadId === id) openThread(null);
      await loadThreads();
    } catch (err) { setError(String(err?.message ?? err)); }
  };

  return (
    <div className="loop-chat">
      <aside className="loop-chat-rail">
        <button type="button" className="loop-chat-new" onClick={() => openThread(null)}>+ New</button>
        {threads.map(t => (
          <div key={t.id} className={`loop-chat-thread${threadId === t.id ? ' active' : ''}`}>
            <button type="button" className="pick" onClick={() => openThread(t.id)} title={t.title}>
              {t.title}
            </button>
            <button
              type="button"
              className="link del"
              title="Delete this thread"
              onClick={() => removeThread(t.id)}
            >{pendingDelete === t.id ? 'sure?' : '×'}</button>
          </div>
        ))}
        {!threads.length && <p className="empty">No conversations yet.</p>}
      </aside>

      <div className="loop-chat-main">
        <div
          className="loop-chat-body"
          ref={bodyRef}
          onScroll={e => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {!turns.length && !busy && (
            <Starters blockers={boardBlockers} onPick={q => setText(q)} />
          )}

          {turns.map((t, i) => <Turn key={`${t.at}-${i}`} turn={t} onOpenTask={onOpenTask} />)}

          {/* The turn in progress: tool calls as they happen, then the tokens. */}
          {busy && (
            <div className="loop-chat-turn assistant live">
              {liveCalls.map((c, i) => <ToolLine key={i} call={c} />)}
              {streaming
                ? <p className="text">{streaming}<span className="live-caret" /></p>
                : <p className="text thinking">Thinking<span className="live-caret" /></p>}
            </div>
          )}
        </div>

        {error && <div className="loop-chat-error" role="alert">{error}</div>}

        <form className="loop-chat-compose" onSubmit={e => { e.preventDefault(); send(); }}>
          <div className="loop-chat-model">
            <ModelPicker
              worker={worker}
              activeModels={activeModels}
              idPrefix="loop-chat"
              placeholder="Loop's bands"
              onChange={chooseModel}
            />
            {/* This is a chat box wired to a paid API, so the number belongs
                next to the send button rather than in a settings page. */}
            <span className="loop-chat-cost" title="rough cost of one turn on this model">
              {estimateTurn(worker, activeModels)}
            </span>
          </div>
          <textarea
            value={text}
            rows={2}
            placeholder="Ask about the backlog, or describe work to queue…"
            disabled={busy}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
          />
          {busy
            ? <button type="button" className="reject" onClick={() => window.flyt.chatStop(projectId, threadId)}>Stop</button>
            : <button type="submit" className="primary" disabled={!text.trim()}>Ask</button>}
        </form>
      </div>
    </div>
  );
}

function Turn({ turn, onOpenTask, projectId }) {
  if (turn.role === 'user') {
    return <div className="loop-chat-turn user"><p className="text">{turn.text}</p></div>;
  }
  return (
    <div className="loop-chat-turn assistant">
      {(turn.toolCalls ?? []).map((c, i) => <ToolLine key={i} call={c} />)}
      {turn.error
        ? <p className="text err">{turn.error}</p>
        : <p className="text">{turn.text}</p>}
      {/* The model proposes; the human commits. */}
      {(turn.proposals ?? []).map(p => (
        <Proposal key={p.id ?? p.title} proposal={p} projectId={projectId} onOpenTask={onOpenTask} />
      ))}
      {turn.model && <p className="loop-chat-meta">{turn.model}</p>}
    </div>
  );
}

/**
 * One tool call, collapsed to a line — `read_task t-0008 ✓ 12ms` — expandable.
 *
 * Never hidden. A chat that reads forty files without saying so is a chat you
 * cannot audit, and auditability is the trade this whole app makes.
 */
function ToolLine({ call }) {
  const [open, setOpen] = useState(false);
  const subject = subjectOf(call.tool, call.args);
  return (
    <div className={`loop-chat-tool${call.ok === false ? ' failed' : ''}`}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <code className="mono">{call.tool}</code>
        {subject && <span className="subject">{subject}</span>}
        <span className="glyph">{call.ok === false ? '✕' : '✓'}</span>
        {call.ms != null && <span className="ms">{call.ms < 1000 ? `${call.ms}ms` : `${Math.round(call.ms / 100) / 10}s`}</span>}
      </button>
      {open && <pre className="args">{JSON.stringify(call.args ?? {}, null, 2)}</pre>}
      {call.error && <p className="err">{call.error}</p>}
    </div>
  );
}

// A task the model PROPOSED, shown before it exists. Chat turns call
// enqueue_task in propose mode, so unlike the old card this one is not already
// written when it appears: Queue it is the commit — `task:add` with the
// proposed body verbatim, landing on the exact id the proposal reserved — and
// Discard closes the card with nothing ever on disk. The model proposes; the
// human commits.
function Proposal({ proposal, projectId, onOpenTask }) {
  const [state, setState] = useState('pending'); // pending | queued | discarded
  const [queueError, setQueueError] = useState(null);
  const queue = async () => {
    setQueueError(null);
    try {
      // The body the model proposed, committed by the one person who can. The
      // id goes in with it so the task lands on the id the card showed —
      // reserved at proposal time, claimed here (task:add, one door).
      const r = await window.flyt.addTask(projectId, proposal.task ?? { id: proposal.id, title: proposal.title, goal: proposal.goal });
      setState('queued');
      if (onOpenTask) onOpenTask(r?.id ?? proposal.id);
    } catch (err) { setQueueError(String(err?.message ?? err)); }
  };
  return (
    <div className={`loop-chat-proposal${state !== 'pending' ? ` ${state}` : ''}`}>
      <div className="head">
        <span className="badge">{state === 'pending' ? 'proposed' : state}</span>
        <code className="mono">{proposal.id}</code>
        <strong>{proposal.title}</strong>
      </div>
      {proposal.goal && <p className="goal">{proposal.goal}</p>}
      {state === 'pending' && (
        <div className="loop-chat-proposal-actions">
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

/**
 * Three starter prompts, derived from the board's actual state.
 *
 * Generated from `boardBlockers` and never generic: "Why is t-0008 blocked?"
 * on a board where t-0008 is blocked is a question worth pressing, and
 * "Ask me anything!" is not.
 */
function Starters({ blockers = [], onPick }) {
  const first = blockers.find(b => b.subjects?.length) ?? blockers[0] ?? null;
  const prompts = [
    first?.subjects?.[0] ? `Why is ${first.subjects[0]} blocked?` : 'What is stopping the queue?',
    'What should I work on next, and why that one?',
    'Turn this into tasks: '
  ];
  return (
    <div className="loop-chat-starters">
      <p>This reads your backlog and can queue work. It cannot write files or run commands — that is the loop&rsquo;s job.</p>
      {prompts.map(p => (
        <button key={p} type="button" onClick={() => onPick(p)}>{p}</button>
      ))}
    </div>
  );
}

// The one argument worth showing on a collapsed line, per tool. Same idea as
// src/loopLive.js argsPreview, kept local because the two lists answer to
// different toolsets and coupling them would make each one wrong for the other.
function subjectOf(tool, args) {
  if (!args || typeof args !== 'object') return null;
  const key = {
    read_task: 'id', why_blocked: 'id', read_file: 'path', glob: 'pattern',
    search_references: 'query', read_run: 'runId', enqueue_task: 'title', list_tasks: 'status'
  }[tool];
  const v = key ? args[key] : Object.values(args).find(x => typeof x === 'string');
  if (typeof v !== 'string' || !v.trim()) return null;
  const one = v.trim().replace(/\s+/g, ' ');
  return one.length > 48 ? `${one.slice(0, 45)}…` : one;
}

/**
 * Roughly what one turn costs on this model.
 *
 * Deliberately labelled "~" and derived from the catalogue's own prices: an
 * estimate presented as a measurement is a lie, and this is a number someone
 * will compare against a bill. When the catalogue has no price, it says so
 * instead of guessing.
 */
function estimateTurn(worker, activeModels) {
  if (!worker?.model) return '';
  const facts = activeModels.find(m => m.id === worker.model);
  const inUsd = facts?.pricing?.prompt ?? facts?.promptUsd ?? null;
  const outUsd = facts?.pricing?.completion ?? facts?.completionUsd ?? null;
  if (inUsd == null || outUsd == null) return 'price unknown';
  // ~8k in (the board summary plus a couple of tool results), ~700 out.
  const usd = 8000 * Number(inUsd) + 700 * Number(outUsd);
  return usd >= 0.01 ? `~$${usd.toFixed(2)}/turn` : `~$${usd.toFixed(4)}/turn`;
}
