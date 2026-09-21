import React, { useCallback, useEffect, useRef, useState } from 'react';
import ComposerMenu, { MenuOption } from '../v2/ComposerMenu.jsx';
import { channelUi, subjectOf } from './chatChannels.js';
import { chatTransport } from './chatTransport.js';
import './chatStyles.css';

// The chat window, once (DECISIONS.md D45, D87).
//
// There are two of these on screen in this app — the Loop drawer and the Build
// modal — and they were two copies of the same four hundred lines until this
// file existed. They are one component now, so a fix to the tool line or the
// send button lands on both, and the things that genuinely differ arrive as
// props: the channel it addresses and the cards it draws for what that channel
// proposes.
//
// WHAT IS NOT HERE, and was: starter prompts, a paragraph explaining what the
// chat can and cannot do, and a heading over an empty pane. People know what a
// text box is. The window is the composer — the same shape as the loop
// designer's, down to the pill and the round send button — and it grows a
// transcript above itself once there is one.
//
// Two things here are deliberate and easy to get wrong:
//
//   Tool calls render as one collapsed line each, never hidden. The trust model
//   of this whole app is that you can see what it did, and a chat that quietly
//   reads forty files is the first place that would stop being true.
//
//   Nothing a model proposes is committed by the model. The channel supplies
//   `renderProposal`, and that card's button is the human making the call —
//   `task:add` on the Loop, a `stack:` command in Build.

const glyph = path => <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">{path}</svg>;
const SendIcon = () => glyph(<path d="M2.6 8h9.4M8.2 4.2 12 8l-3.8 3.8" />);
const StopIcon = () => glyph(<rect x="4.5" y="4.5" width="7" height="7" rx="1.4" />);
const ModelIcon = glyph(<path d="M8 2.4 9.4 6.6 13.6 8 9.4 9.4 8 13.6 6.6 9.4 2.4 8 6.6 6.6z" />);
const ThreadIcon = glyph(<><path d="M13.4 9.6a1 1 0 0 1-1 1H6l-2.4 2V4.4a1 1 0 0 1 1-1h7.8a1 1 0 0 1 1 1z" /></>);

export default function Chat({
  channel = 'loop',
  projectId,
  activeModels = [],
  // The transport is injectable so a test can drive this without an Electron
  // preload, and so a future surface can address a channel this file has never
  // heard of without editing it.
  transport = null,
  placeholder = null,
  // One card per thing this channel's turn proposed. Given the raw proposal and
  // the thread it came from; returns a node, or null to draw nothing.
  renderProposal = null,
  // Earlier conversations. A pill in the composer rather than a rail beside it:
  // the rail was permanently on screen to hold a list that is usually empty.
  showThreads = true,
  autoFocus = false,
  onError = null,
}) {
  const ui = channelUi(channel);
  const wire = useRef(null);
  if (!wire.current || wire.current.channel !== channel) {
    wire.current = transport ?? chatTransport(channel);
  }
  const chat = transport ?? wire.current;

  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(null);
  const [turns, setTurns] = useState([]);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState('');
  const [liveCalls, setLiveCalls] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [worker, setWorker] = useState(null);
  const bodyRef = useRef(null);
  const inputRef = useRef(null);
  const stick = useRef(true);

  const fail = useCallback(err => {
    const message = String(err?.message ?? err);
    setError(message);
    onError?.(message);
  }, [onError]);

  const loadThreads = useCallback(async () => {
    if (!projectId || !chat.available) return;
    try { setThreads((await chat.threads(projectId))?.threads ?? []); }
    catch (err) { fail(err); }
  }, [projectId, chat, fail]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  // The model this person already chose FOR THIS CHANNEL, restored per install.
  useEffect(() => {
    let alive = true;
    chat.readWorker().then(saved => { if (alive) setWorker(saved); });
    return () => { alive = false; };
  }, [chat]);

  // A channel change is a different conversation, not the same one relabelled.
  useEffect(() => { setThreadId(null); setTurns([]); setStreaming(''); setLiveCalls([]); }, [channel, projectId]);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus]);

  const openThread = useCallback(async id => {
    setThreadId(id);
    setStreaming('');
    setLiveCalls([]);
    if (!id) { setTurns([]); return; }
    try { setTurns((await chat.read(projectId, id))?.turns ?? []); }
    catch (err) { fail(err); }
  }, [projectId, chat, fail]);

  // Streaming tokens and tool calls, live. The persisted turn arrives when
  // `send` resolves; this is only what happens BEFORE that write.
  useEffect(() => {
    if (!projectId) return undefined;
    return chat.subscribe(event => {
      if (event.projectId !== projectId || event.threadId !== threadId) return;
      if (event.kind === 'text') setStreaming(event.text ?? '');
      else if (event.kind === 'tool') setLiveCalls(prev => [...prev, event]);
    });
  }, [projectId, threadId, chat]);

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
      try { id = (await chat.create(projectId))?.threadId; }
      catch (err) { fail(err); return; }
      setThreadId(id);
    }
    setText('');
    setBusy(true);
    setError(null);
    setStreaming('');
    setLiveCalls([]);
    // Optimistic: the question appears the instant it is asked, because a send
    // button that does nothing visible for four seconds is a send button people
    // press twice.
    setTurns(prev => [...prev, { role: 'user', text: question, at: new Date().toISOString() }]);
    try {
      await chat.send(projectId, id, question, worker);
      setTurns((await chat.read(projectId, id))?.turns ?? []);
      await loadThreads();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
      setStreaming('');
      setLiveCalls([]);
    }
  };

  const chooseModel = async next => {
    setWorker(next);
    try { await chat.saveWorker(next); }
    catch (err) { fail(err); }
  };

  const removeThread = async (id, close) => {
    try {
      await chat.remove(projectId, id);
      if (threadId === id) openThread(null);
      await loadThreads();
      close?.();
    } catch (err) { fail(err); }
  };

  // The transcript only exists once there is one. An empty pane with a heading
  // over it is the thing this window used to open as.
  const transcript = turns.length > 0 || busy;

  return (
    <div className="flyt-chat" data-channel={channel}>
      {transcript && (
        <div
          className="flyt-chat-body"
          role="log"
          aria-live="polite"
          ref={bodyRef}
          onScroll={event => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {turns.map((turn, index) => (
            <Turn key={`${turn.at}-${index}`} turn={turn} channel={channel}
              threadId={threadId} renderProposal={renderProposal} />
          ))}

          {/* The turn in progress: tool calls as they happen, then the tokens. */}
          {busy && (
            <div className="flyt-chat-turn assistant live">
              {liveCalls.map((call, index) => <ToolLine key={index} call={call} channel={channel} />)}
              {streaming
                ? <p className="text">{streaming}<span className="live-caret" /></p>
                : <p className="text thinking">Thinking<span className="live-caret" /></p>}
            </div>
          )}
        </div>
      )}

      {error && <p className="flyt-chat-error" role="alert">{error}</p>}

      <form onSubmit={event => { event.preventDefault(); send(); }}>
        <div className="flyt-composer">
          <label className="flyt-chat-sr-only" htmlFor={`flyt-chat-${channel}-input`}>
            {ui.title}
          </label>
          <textarea
            id={`flyt-chat-${channel}-input`}
            ref={inputRef}
            value={text}
            rows={3}
            maxLength={8000}
            placeholder={placeholder ?? ui.placeholder}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
            }}
          />

          <div className="flyt-composer-foot">
            {showThreads && (
              <ComposerMenu label="Conversation" value={threadLabel(threads, threadId)} icon={ThreadIcon} disabled={busy}>
                {close => <>
                  <ul>
                    <MenuOption current={!threadId} onClick={() => { openThread(null); close(); }}>New conversation</MenuOption>
                    {threads.map(thread => (
                      <MenuOption key={thread.id} current={threadId === thread.id}
                        onClick={() => { openThread(thread.id); close(); }}>{thread.title}</MenuOption>
                    ))}
                  </ul>
                  {threadId && (
                    <button type="button" className="flyt-chat-forget"
                      onClick={() => removeThread(threadId, close)}>Delete this conversation</button>
                  )}
                </>}
              </ComposerMenu>
            )}

            {/* This is a chat box wired to a paid API, so the model and what a
                turn costs belong next to the send button rather than in a
                settings page. */}
            <ComposerMenu label="Model" value={worker?.model || 'Model'} icon={ModelIcon} className="push" disabled={busy}>
              {close => <>
                <ul>
                  <MenuOption current={!worker?.model} onClick={() => { chooseModel(null); close(); }}>Loop&rsquo;s bands</MenuOption>
                  {activeModels.map(model => (
                    <MenuOption key={model.id} current={worker?.model === model.id}
                      note={estimateTurn({ model: model.id }, activeModels) || null}
                      onClick={() => { chooseModel({ provider: model.provider ?? 'auto', model: model.id }); close(); }}>
                      {model.id}
                    </MenuOption>
                  ))}
                </ul>
                {!activeModels.length && <p className="goal-menu-empty">No models are enabled for this project.</p>}
              </>}
            </ComposerMenu>

            {busy
              ? <button type="button" className="flyt-chat-send stop" aria-label="Stop"
                  onClick={() => chat.stop(projectId, threadId)}><StopIcon /></button>
              : <button type="submit" className="flyt-chat-send" aria-label="Send message"
                  disabled={!text.trim()}><SendIcon /></button>}
          </div>
        </div>
      </form>
    </div>
  );
}

/** The pill's own label: which conversation this is, in as few words as fit. */
function threadLabel(threads, threadId) {
  if (!threadId) return 'New';
  const found = threads.find(thread => thread.id === threadId);
  return found?.title ?? 'This conversation';
}

function Turn({ turn, channel, threadId, renderProposal }) {
  if (turn.role === 'user') {
    return <div className="flyt-chat-turn user"><p className="text">{turn.text}</p></div>;
  }
  const proposals = turn.proposals ?? [];
  return (
    <div className="flyt-chat-turn assistant">
      {(turn.toolCalls ?? []).map((call, index) => <ToolLine key={index} call={call} channel={channel} />)}
      {turn.error
        ? <p className="text err">{turn.error}</p>
        : <p className="text">{turn.text}</p>}
      {/* The model proposes; the human commits. What the card looks like and
          what its button calls belong to the channel, not to this file. */}
      {renderProposal && proposals.map((proposal, index) => (
        <React.Fragment key={proposal.id ?? proposal.title ?? index}>
          {renderProposal(proposal, { threadId })}
        </React.Fragment>
      ))}
      {turn.model && <p className="flyt-chat-meta">{turn.model}</p>}
    </div>
  );
}

/**
 * One tool call, collapsed to a line — `read_task t-0008 ✓ 12ms` — expandable.
 *
 * Never hidden. A chat that reads forty files without saying so is a chat you
 * cannot audit, and auditability is the trade this whole app makes.
 */
export function ToolLine({ call, channel = 'loop' }) {
  const [open, setOpen] = useState(false);
  const subject = subjectOf(channel, call.tool, call.args);
  return (
    <div className={`flyt-chat-tool${call.ok === false ? ' failed' : ''}`}>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open}>
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

/**
 * Roughly what one turn costs on this model.
 *
 * Deliberately labelled "~" and derived from the catalogue's own prices: an
 * estimate presented as a measurement is a lie, and this is a number someone
 * will compare against a bill. When the catalogue has no price, it says
 * nothing rather than guessing.
 */
export function estimateTurn(worker, activeModels) {
  if (!worker?.model) return '';
  const facts = activeModels.find(model => model.id === worker.model);
  const inUsd = facts?.pricing?.prompt ?? facts?.promptUsd ?? null;
  const outUsd = facts?.pricing?.completion ?? facts?.completionUsd ?? null;
  if (inUsd == null || outUsd == null) return '';
  // ~8k in (the surface's own summary plus a couple of tool results), ~700 out.
  const usd = 8000 * Number(inUsd) + 700 * Number(outUsd);
  return usd >= 0.01 ? `~$${usd.toFixed(2)}` : `~$${usd.toFixed(4)}`;
}
