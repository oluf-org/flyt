// The chat surface — home's second state (CHAT-RUN). Instead of navigating to
// the Runs section when the lander composer fires, the conversation stays put
// and the live flow unfolds *below* the thread in one scrollable column:
// scroll down to watch the run, scroll back up to re-read what you asked for.
//
// The run itself reads like a chat transcript (run-feed rework): the graph is
// flattened into a downward feed of node cards in execution order — each node
// a "message" that streams while it works and lands with its output. The full
// canvas stays one toggle away for the graph view; an opt-in summary sidebar
// answers "what has it produced so far" without scrolling.
//
// The thread is derived, never duplicated: the run's own prompt and follow-up
// turns ARE the chat history (snapshot.prompt + snapshot.followups), so a tab
// restore or a resumed session rebuilds the conversation from the run record.
//
// The composer speaks follow-up (run:followUp), which the engine only accepts
// once a run settles — while it's working or parked at a gate the composer
// says so instead of pretending a reply would land.
//
// Approval gates are blocking: a large dialog owns the surface (minimizable
// to the slim bar for reviewing first), and when the window isn't focused the
// main process raises an OS notification + taskbar flash so a parked run is
// never silently stuck (app:approvalGate IPC).
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import InputGate from './InputGate.jsx';
import FlowCanvas from './FlowCanvas.jsx';
import RunBar from './RunBar.jsx';
import RunControls from './RunControls.jsx';
import RunFailure from './RunFailure.jsx';
import NodeFocus from './NodeFocus.jsx';
import NodeFeed from './NodeFeed.jsx';
import ChatSidebar from './ChatSidebar.jsx';
import ApprovalModal, { gateCopy } from './ApprovalModal.jsx';
import { feedItems, runFailure } from './nodeFeedData.js';
import { isTerminal } from './runProgress.js';
import { sigil } from './sigil.js';
import { APP_NAME } from '../core/brand.js';

// View + sidebar preferences survive the session — a user who prefers the
// graph (or always wants summaries) shouldn't have to re-pick per run.
const readPref = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const writePref = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* private mode: prefs are session-only */ }
};

export default function ChatRun({
  snapshot, runId, projectId, seed,
  followRun, onFollowChange, runControl,
  onFollowUp, onAnswerInput, onNewChat,
  onOpenFolder, onOpenWorkspace,
  onResume, resuming, onApprove, onReject,
  activeModels, runToast, coachTip, onDismissCoachTip
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selectedNode, setSelectedNode] = useState(null);
  const [focusNodeId, setFocusNodeId] = useState(null);
  const [view, setView] = useState(() => readPref('chatrun:view', 'feed'));
  const [sideOpen, setSideOpen] = useState(() => readPref('chatrun:side', '0') === '1');
  const [gateMinimized, setGateMinimized] = useState(false);
  const flowRef = useRef(null);
  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const taRef = useRef(null);

  const loaded = snapshot?.meta?.runId === runId;
  const meta = loaded ? snapshot.meta : null;
  const stage = meta?.stage;
  const live = Boolean(loaded && !isTerminal(stage));
  const paused = Boolean(meta?.paused);
  const gated = stage === 'awaiting_approval';
  // The input gate (DECISIONS.md D27): the run is parked with clarifying
  // questions answered from the composer — not an approve/reject dialog, so it
  // gets an inline card, not the blocking ApprovalModal.
  const awaitingInput = stage === 'awaiting_input';
  const questions = awaitingInput ? (meta?.pendingQuestions ?? []) : [];
  // WHICH node is asking. Three roles park here — the refiner, the orientation
  // (D38) and the interrogation (D46) — and the card announced all three as
  // "the refiner", so the one piece of context the reader needs in order to
  // answer well was the thing the card got wrong.
  const askingNode = awaitingInput
    ? (snapshot?.flow?.nodes ?? []).find(n => n.id === meta?.pendingNodeId) ?? null
    : null;
  const askingTitle = askingNode?.data?.title || askingNode?.id || 'This run';
  const parked = gated || awaitingInput;
  // Gate copy shared by the dialog and the minimized dock (gated ⇒ meta non-null).
  const gate = gated ? gateCopy(meta) : null;
  const followups = loaded ? (snapshot.followups ?? []) : [];

  // The feed is derived once per snapshot push and shared by the feed, the
  // sidebar, and the scroll logic (its size is a handful of nodes — deriving
  // three times would still be cheap, but once is clearer).
  const items = useMemo(() => (loaded ? feedItems(snapshot) : []), [loaded, snapshot]);
  // The cause of death, when there is one — see RunFailure.
  const failure = useMemo(() => (loaded ? runFailure(snapshot, items) : null), [loaded, snapshot, items]);

  // Retrying relaunches the run, so the failure panel disappears on its own
  // with the next snapshot push; the flag only covers the round trip.
  const retry = async (nodeId, guidance, worker) => {
    if (retrying) return;
    setRetrying(true);
    try { await runControl.restart(nodeId, guidance, worker); }
    finally { setRetrying(false); }
  };

  const pickView = v => { setView(v); writePref('chatrun:view', v); };
  const toggleSide = () => setSideOpen(s => { writePref('chatrun:side', s ? '0' : '1'); return !s; });

  // --- Chat-scroll behavior ---------------------------------------------------
  // Stick-to-bottom, the chat-client contract: while the user is at the tail,
  // every new node/stream line glides the view down with it; the moment they
  // scroll up to read, the view is theirs and a "jump to latest" chip appears
  // when fresh work lands below.
  const stuckRef = useRef(true);
  const [jumpChip, setJumpChip] = useState(false);

  const scrollToBottom = smooth => {
    const el = scrollRef.current;
    if (!el) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? 'smooth' : 'auto' });
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const stuck = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    stuckRef.current = stuck;
    if (stuck) setJumpChip(false);
  };

  // A cheap signature of "what's new below": count + states + streamed chars.
  const feedSig = useMemo(() => {
    let sig = items.length + '|';
    for (const it of items) sig += it.status + (it.streamText?.length ?? 0) + ',';
    return sig;
  }, [items]);

  useEffect(() => {
    if (!loaded) return;
    if (stuckRef.current) scrollToBottom(false);
    else setJumpChip(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedSig, loaded]);

  // The unfold: when the flow first appears and whenever a new turn lands,
  // glide the run surface into view. Never on a steady-state push — the user
  // scrolling back up to re-read must never be yanked down.
  const turnCount = followups.length;
  useEffect(() => {
    const el = flowRef.current;
    if (!el || !loaded) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
    stuckRef.current = true;
  }, [loaded, turnCount]);

  // --- Approval gate: big dialog + OS-level nudge when unfocused ---------------
  // One key per gate occurrence so a fresh gate re-raises the dialog even if
  // the last one was minimized, and so the notification fires exactly once
  // per park (not on every snapshot push while gated).
  const gateKey = parked
    ? `${runId}:${meta?.pendingGateKind ?? 'plan'}:${meta?.pendingToolCall?.tool ?? ''}:${meta?.pendingToolCall?.summary ?? ''}`
    : null;
  const prevGateKey = useRef(null);
  useEffect(() => {
    if (gateKey === prevGateKey.current) return;
    const was = prevGateKey.current;
    prevGateKey.current = gateKey;
    if (gateKey) {
      setGateMinimized(false);
      const runLabel = meta?.name ?? meta?.flowName ?? 'A run';
      if (awaitingInput) {
        window.flyt?.signalApprovalGate?.({
          state: 'pending',
          title: `Input needed — ${APP_NAME}`,
          body: `${runLabel} is waiting for your answer to continue.`
        });
      } else {
        const copy = gateCopy(meta);
        window.flyt?.signalApprovalGate?.({
          state: 'pending',
          title: copy.danger ? 'Dangerous tool call needs approval' : `Approval needed — ${APP_NAME}`,
          body: copy.kind === 'tool'
            ? `${runLabel} wants to run ${copy.tool.tool}${copy.tool.summary ? ` on ${copy.tool.summary}` : ''}. Paused until you decide.`
            : `${runLabel} is parked at an approval gate. Paused until you decide.`
        });
      }
    } else if (was) {
      window.flyt?.signalApprovalGate?.({ state: 'resolved' });
    }
    // meta is read for the copy only; the gate key owns re-firing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateKey]);

  // Composer enablement mirrors followUpBlocker engine-side: terminal runs
  // only. Everything else gets a placeholder that explains the hold-up.
  const composerHint = !loaded
    ? 'Starting the flow…'
    : awaitingInput
      ? 'Answer the question(s) above to continue the run…'
      : gated
        ? 'Answer the approval gate to continue…'
        : live
          ? 'The flow is working — reply when it settles…'
          : 'Reply to steer the flow — Shift+Enter for a new line…';
  // The input gate is the one live state that WANTS the composer: answering it
  // is how the run proceeds. Everything else stays follow-up (terminal only).
  const canSend = loaded && text.trim().length > 0 && !sending
    && (awaitingInput || (!live && !gated));

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      if (awaitingInput) await onAnswerInput(text.trim());
      else await onFollowUp(text.trim());
      setText('');
    }
    finally { setSending(false); taRef.current?.focus(); }
  };

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  return (
    <main className="chat-run">
      <div className="chat-topbar">
        <button type="button" className="ghost mini" onClick={onNewChat} title="Start a fresh chat — this run keeps going in the Runs section">
          <span aria-hidden>＋</span> New chat
        </button>
        {loaded && (
          <div className="view-switch" role="tablist" aria-label="Run view">
            <button
              type="button" role="tab" aria-selected={view === 'feed'}
              className={'view-btn' + (view === 'feed' ? ' active' : '')}
              onClick={() => pickView('feed')}
              title="Nodes as a chat-style feed — scroll down with the run"
            ><span className="view-btn-glyph">☰</span> Feed</button>
            <button
              type="button" role="tab" aria-selected={view === 'canvas'}
              className={'view-btn' + (view === 'canvas' ? ' active' : '')}
              onClick={() => pickView('canvas')}
              title="The full node graph, live"
            ><span className="view-btn-glyph">◇</span> Canvas</button>
          </div>
        )}
        <div className="toolbar-spacer" />
        {meta && (
          <>
            <span
              className="chat-run-sigil"
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: sigil(runId, 18) }}
            />
            <span className="chat-run-name" title={runId}>{meta.name ?? meta.flowName ?? 'Run'}</span>
            {meta.modeName && <span className="mode-chip" title="Mode this run was launched with">{meta.modeName}</span>}
            {stage && <span className={'stage-chip' + (stage === 'failed' ? ' stage-failed' : '')}>{stage.replace(/_/g, ' ')}</span>}
          </>
        )}
        {/* Pause / stop live in the pinned topbar, not only on the RunBar the
            feed scrolls away (D39): a run you cannot reach is a run you cannot
            stop. Hidden the instant it settles — nothing to stop. */}
        {live && (
          <RunControls
            paused={paused}
            onPause={runControl.pause}
            onResume={runControl.resume}
            onStop={runControl.stop}
            className="chat-topbar-controls"
          />
        )}
        <button
          type="button"
          className={'ghost mini chat-side-toggle' + (sideOpen ? ' active' : '')}
          onClick={toggleSide}
          aria-pressed={sideOpen}
          title="Summaries — progress and per-node results in a sidebar"
        >
          <span aria-hidden>▤</span> Summary
        </button>
      </div>

      <div className="chat-body">
        <div className="chat-column">
          <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="chat-thread">
              {(seed || meta?.prompt || snapshot?.prompt) && (
                <div className="chat-msg user">
                  <pre>{snapshot?.prompt ?? seed}</pre>
                </div>
              )}
              {followups.map(t => (
                <Fragment key={t.turn}>
                  <div className="chat-msg user"><pre>{t.prompt ?? '(no prompt recorded)'}</pre></div>
                  {t.answer
                    ? <div className="chat-msg assistant"><pre>{t.answer}</pre></div>
                    : <div className="chat-msg system">Turn {t.turn} — the flow grew below ↓</div>}
                </Fragment>
              ))}
            </div>

            <section className="chat-flow" ref={flowRef} aria-label="Run flow">
              <span className="section-label">Flow</span>
              {loaded ? (
                <>
                  <RunBar
                    snapshot={snapshot}
                    onOpenFolder={onOpenFolder}
                    onOpenWorkspace={onOpenWorkspace}
                    onPause={runControl.pause}
                    onResume={runControl.resume}
                    onStop={runControl.stop}
                  />
                  {meta?.interrupted && (
                    <div className="approval-bar">
                      <span className="section-label">Interrupted</span>
                      <span>
                        The app closed while this run was working. Its finished steps are kept —
                        resuming continues from where it stopped.
                      </span>
                      <button className="primary" onClick={onResume} disabled={resuming}>
                        {resuming ? 'Resuming…' : 'Resume'}
                      </button>
                    </div>
                  )}
                  {view === 'feed' ? (
                    <NodeFeed items={items} selectedNode={selectedNode} onSelect={setFocusNodeId} />
                  ) : (
                    <div className="chat-canvas">
                      <FlowCanvas
                        key={runId}
                        snapshot={snapshot}
                        selectedNode={selectedNode}
                        onSelect={setSelectedNode}
                        live={live}
                        paused={paused}
                        follow={followRun}
                        onFollowChange={onFollowChange}
                        onInvestigate={setFocusNodeId}
                        control={runControl}
                      />
                    </div>
                  )}
                  {/* At the tail, not the top: a failure is the newest thing
                      that happened, and the feed already sticks to the tail —
                      so the panel lands under the eye instead of above the
                      scroll. Same place in both views. */}
                  <RunFailure
                    failure={failure}
                    activeModels={activeModels}
                    retrying={retrying}
                    onRetry={retry}
                    onInspect={setFocusNodeId}
                  />
                </>
              ) : (
                <div className="chat-canvas chat-canvas-loading">
                  <span className="section-label">Starting the flow…</span>
                </div>
              )}
              <div ref={bottomRef} aria-hidden="true" />
            </section>
          </div>

          {jumpChip && !parked && (
            <button
              type="button"
              className="jump-latest"
              onClick={() => { stuckRef.current = true; setJumpChip(false); scrollToBottom(true); }}
            >
              ↓ New activity — jump to latest
            </button>
          )}

          {/* The input gate (T6): questions docked above the composer, answered
              inline. Not blocking like an approval gate — the user reads the
              run, then types one reply covering the questions. */}
          {awaitingInput && (
            <InputGate
              questions={questions}
              askedBy={askingTitle}
              icon={askingNode?.data?.icon || '✍'}
              onPick={(q, o) => {
                setText(t => (t.trim() ? `${t.trimEnd()}\n${q.text} — ${o}` : `${q.text} — ${o}`));
                taRef.current?.focus();
              }}
            />
          )}

          {/* The minimized gate docks above the composer — outside the scroll
              area, so "Review first" can never strand the decision off-screen
              at the top of the feed. Details ↑ reopens the full dialog. */}
          {gated && gateMinimized && gate && (
            <div className={'gate-dock' + (gate.danger ? ' danger' : '')} role="status">
              <span className="gate-dock-glyph" aria-hidden>{gate.danger ? '⚠' : '⏸'}</span>
              <span className="gate-dock-text">
                <strong>{gate.title}</strong>
                {gate.kind === 'tool' && (
                  <span className="mono gate-dock-cmd" title={gate.tool.summary ?? undefined}>
                    {gate.tool.tool}{gate.tool.summary ? ` ${gate.tool.summary}` : ''}
                  </span>
                )}
                <span className="gate-dock-sub">Paused until you decide.</span>
              </span>
              <button className="primary" onClick={onApprove}>{gate.danger ? 'Approve anyway' : 'Approve'}</button>
              <button className="reject" onClick={onReject}>Reject</button>
              <button className="ghost mini" onClick={() => setGateMinimized(false)} title="Reopen the full approval dialog">
                Details ↑
              </button>
            </div>
          )}

          <div className="chat-composer">
            <textarea
              ref={taRef}
              className="chat-input"
              placeholder={composerHint}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={onKeyDown}
              aria-label={awaitingInput ? `Answer the question from ${askingTitle}` : 'Reply to the run'}
              disabled={!loaded || gated || (live && !awaitingInput)}
              rows={2}
            />
            <button
              type="button"
              className="lander-run primary"
              onClick={submit}
              disabled={!canSend}
            >
              {sending ? 'Sending…' : 'Send'}<kbd className="shortcut">↵</kbd>
            </button>
          </div>
        </div>

        {sideOpen && loaded && <ChatSidebar snapshot={snapshot} items={items} />}
      </div>

      {focusNodeId && loaded && (
        <div className="chat-focus-overlay">
          <NodeFocus
            snapshot={snapshot}
            nodeId={focusNodeId}
            projectId={projectId}
            runId={runId}
            live={live}
            activeModels={activeModels}
            onClose={() => setFocusNodeId(null)}
            onRestart={runControl.restart}
            onBranch={runControl.branch}
            onOpenFolder={onOpenFolder}
          />
        </div>
      )}

      {gated && !gateMinimized && (
        <ApprovalModal
          meta={meta}
          runName={meta?.name ?? meta?.flowName ?? null}
          onApprove={onApprove}
          onReject={onReject}
          onMinimize={() => setGateMinimized(true)}
        />
      )}

      {/* Same run-mode overlays as the canvas view, anchored to .chat-run. */}
      {runToast && <div className="run-toast" role="status">{runToast}</div>}
      {coachTip && (
        <div className="coach-tip" role="note">
          <span className="section-label">Tip</span>
          <span className="coach-tip-text">
            Right-click any node for run actions — investigate, restart, branch, pause, stop.
          </span>
          <button className="link" onClick={onDismissCoachTip} aria-label="Dismiss tip">✕</button>
        </div>
      )}
    </main>
  );
}
