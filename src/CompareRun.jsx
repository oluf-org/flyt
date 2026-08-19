// DECISIONS.md D27 (T12) — the split-view comparison surface. Two ordinary
// runs launched from one prompt, shown side by side: each pane keeps its own
// feed, gates and stage; a decision in one never blocks the other. The logic
// (pane state, composer channels, broadcast reach) lives in compareRun.js so
// this file stays a view; the thread header and shared composer are the only
// pieces the two panes have in common.
//
// Streaming is self-contained (the plan's design): run:update already broadcasts
// every run, so this component subscribes and keeps two snapshots itself rather
// than routing through App's single-run snapshot. Same merge rules as App —
// full replaces, a patch merges when its base lines up, else we resync.
import { useEffect, useMemo, useRef, useState } from 'react';
import RunBar from './RunBar.jsx';
import NodeFeed from './NodeFeed.jsx';
import { gateCopy } from './ApprovalModal.jsx';
import { feedItems } from './nodeFeedData.js';
import { mergeSnapshot } from '../core/snapshotDiff.js';
import { sigil } from './sigil.js';
import { APP_NAME } from '../core/brand.js';
import {
  paneLabel, paneStatus, sendPlan, canBroadcast, diffResolvedFlows
} from './compareRun.js';

export default function CompareRun({
  runIds, projectId, seed,
  onExit, runControlFor,
  onFollowUp, onAnswerInput, onApprove, onReject,
  onOpenRun, onOpenFolder, onSaveConfig, onRematch,
  comparison, onJudge, judging
}) {
  const [snaps, setSnaps] = useState({}); // runId -> snapshot (with .rev)
  const snapsRef = useRef(snaps);
  useEffect(() => { snapsRef.current = snaps; }, [snaps]);

  // A stable key for the pair so effects re-arm only when the runs actually
  // change (not on every snapshot push).
  const pairKey = runIds.join('|');

  // Initial load: fetch both snapshots once for this pair. A run switch (rare —
  // a compare tab is a fixed pair) clears and refetches.
  useEffect(() => {
    let live = true;
    setSnaps({});
    for (const id of runIds) {
      window.flyt.getSnapshot(projectId, id)
        .then(s => { if (live && s) setSnaps(prev => ({ ...prev, [id]: s })); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, projectId]);

  // Live stream: mirror App's onRunUpdate merge, but for both runs in the pair.
  useEffect(() => {
    return window.flyt.onRunUpdate(payload => {
      const { runId } = payload;
      if (payload.projectId && payload.projectId !== projectId) return;
      if (!runIds.includes(runId)) return;
      const cur = snapsRef.current[runId];
      if (payload.full) {
        setSnaps(prev => ({ ...prev, [runId]: { ...payload.full, rev: payload.rev } }));
        return;
      }
      if (!cur) return; // no baseline yet — the initial fetch will carry it
      if (payload.base !== cur.rev) {
        window.flyt.getSnapshot(projectId, runId).then(s => {
          const now = snapsRef.current[runId];
          if (s && (now?.rev ?? 0) <= s.rev) setSnaps(prev => ({ ...prev, [runId]: s }));
        });
        return;
      }
      setSnaps(prev => ({ ...prev, [runId]: { ...mergeSnapshot(cur, payload.patch), rev: payload.rev } }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairKey, projectId]);

  const paneSnaps = runIds.map(id => snaps[id] ?? null);
  const statuses = runIds.map((id, i) => paneStatus(paneSnaps[i], id));

  // The shared prompt: both runs launched from the same text, so read it from
  // whichever snapshot has landed (falling back to the seed for the first beat).
  const prompt = paneSnaps.find(s => s?.prompt)?.prompt ?? seed ?? '';

  // P2 "what differed" header: computed from the two runs' own RESOLVED
  // flow.json snapshots, so it stays accurate even if the flow and its modes
  // were edited twenty times since. Identical configs collapse to one line.
  const flowDiff = (paneSnaps[0]?.flow && paneSnaps[1]?.flow)
    ? diffResolvedFlows(paneSnaps[0].flow, paneSnaps[1].flow)
    : null;

  // Manual pairings may couple runs launched from different prompts — legal
  // (the question is inspection, not a new run), but worth a hint.
  const promptsDiffer = paneSnaps.length === 2
    && paneSnaps.every(s => s?.prompt != null)
    && paneSnaps[0].prompt !== paneSnaps[1].prompt;

  // --- Shared composer --------------------------------------------------------
  const [text, setText] = useState('');
  const [target, setTarget] = useState('both'); // 'both' | 0 | 1
  const [sending, setSending] = useState(false);
  const taRef = useRef(null);

  const plan = useMemo(() => sendPlan(statuses, target),
    // statuses is derived fresh each render; key on the stages that drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [statuses.map(s => s.stage).join('|'), target]);
  const canSend = text.trim().length > 0 && !sending && plan.length > 0;

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    const body = text.trim();
    try {
      await Promise.all(plan.map(({ index, channel }) => {
        const runId = runIds[index];
        return channel === 'answer' ? onAnswerInput(runId, body) : onFollowUp(runId, body);
      }));
      setText('');
    } finally { setSending(false); taRef.current?.focus(); }
  };

  const onKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  // Nudge the target chooser toward a pane that needs a personal answer: when a
  // side parks at its input gate, steering it individually is the intent.
  useEffect(() => {
    const gated = statuses.findIndex(s => s.awaitingInput);
    if (gated >= 0) setTarget(gated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statuses.map(s => s.awaitingInput).join('|')]);

  // --- OS-level nudge when a pane parks and the window is unfocused -----------
  // Aggregate across both panes: one signal while either is parked, resolved
  // when neither is. Keyed on the combined park signature so it fires once.
  const parkSig = statuses.map((s, i) => (s.parked ? `${runIds[i]}:${s.stage}` : '')).join('|');
  const prevParkSig = useRef('');
  useEffect(() => {
    if (parkSig === prevParkSig.current) return;
    const wasParked = prevParkSig.current.replace(/\|/g, '') !== '';
    prevParkSig.current = parkSig;
    const parked = parkSig.replace(/\|/g, '') !== '';
    if (parked) {
      window.flyt?.signalApprovalGate?.({
        state: 'pending',
        title: `A comparison run needs you — ${APP_NAME}`,
        body: 'One side is parked at a gate. Paused until you decide.'
      });
    } else if (wasParked) {
      window.flyt?.signalApprovalGate?.({ state: 'resolved' });
    }
  }, [parkSig]);

  const targetLabel = target === 'both' ? 'both' : paneLabel(target);
  const composerHint = plan.length === 0
    ? 'Reply when a run settles — Shift+Enter for a new line…'
    : target === 'both'
      ? 'Reply to both runs — Shift+Enter for a new line…'
      : statuses[target]?.awaitingInput
        ? `Answer run ${paneLabel(target)}’s question…`
        : `Reply to run ${paneLabel(target)}…`;

  return (
    <main className="compare-run">
      <div className="chat-topbar">
        <button type="button" className="ghost mini" onClick={onExit} title="Leave the comparison — both runs keep going in the Runs section">
          <span aria-hidden>＋</span> New chat
        </button>
        <span className="compare-topbar-title">Comparing {runIds.length} runs</span>
        <div className="toolbar-spacer" />
        <div className="compare-target" role="group" aria-label="Send target">
          <span className="compare-target-label">Reply to</span>
          <button type="button" className={'seg' + (target === 'both' ? ' active' : '')} onClick={() => setTarget('both')} disabled={!canBroadcast(statuses)}>Both</button>
          {runIds.map((_, i) => (
            <button key={i} type="button" className={'seg' + (target === i ? ' active' : '')} onClick={() => setTarget(i)}>{paneLabel(i)}</button>
          ))}
        </div>
      </div>

      <div className="compare-thread">
        {prompt && (
          <div className="chat-msg user"><pre>{prompt}</pre></div>
        )}
        {promptsDiffer && (
          <div className="compare-diff warn" role="note">
            <span className="compare-diff-glyph" aria-hidden>⚠</span>
            These two runs were launched from different prompts — compare with care.
          </div>
        )}
        {flowDiff && (
          <div
            className={'compare-diff' + (flowDiff.identical ? ' identical' : '')}
            title={flowDiff.entries.length ? flowDiff.entries.map(e => e.text).join('\n') : undefined}
          >
            <span className="compare-diff-glyph" aria-hidden>⇄</span>
            {flowDiff.summary}
          </div>
        )}

        {/* P3 verdict panel (T13): the judge's report between the panes — a
            summary, not a gate. Before the first call it's just the Judge
            action; afterwards the structured half (winner, axes, notes) leads
            and the full report folds open on demand. Re-judging replaces it. */}
        {onJudge && (
          <div className="compare-verdict">
            {comparison?.verdict ? (
              <>
                <div className="compare-verdict-head">
                  {comparison.verdict.winner && (
                    <span className={'compare-verdict-badge ' + (comparison.verdict.winner === 'tie' ? 'tie' : 'win')}>
                      {comparison.verdict.winner === 'tie' ? 'Tie' : `Winner: ${comparison.verdict.winner}`}
                    </span>
                  )}
                  {comparison.verdict.axes && Object.entries(comparison.verdict.axes).map(([axis, side]) => (
                    <span key={axis} className="compare-verdict-axis mono" title={`${axis}: ${side}`}>
                      {axis}: <strong>{side}</strong>
                    </span>
                  ))}
                  <div className="toolbar-spacer" />
                  <button
                    type="button"
                    className="ghost mini"
                    disabled={judging || !statuses.every(s => s.settled)}
                    onClick={onJudge}
                    title="Judge again — replaces this verdict"
                  >
                    {judging ? 'Judging…' : 'Re-judge'}
                  </button>
                </div>
                {comparison.verdict.notes && (
                  <div className="compare-verdict-notes">{comparison.verdict.notes}</div>
                )}
                <details className="compare-verdict-report">
                  <summary>
                    Judge's report
                    <span className="compare-verdict-meta">
                      {comparison.verdict.judgeModel} · {new Date(comparison.verdict.at).toLocaleString()}
                    </span>
                  </summary>
                  <pre>{comparison.verdict.summary}</pre>
                </details>
              </>
            ) : (
              <div className="compare-verdict-head">
                <span className="compare-verdict-hint">No verdict yet — the judge reads both final outputs and grades them. A summary, not a gate.</span>
                <div className="toolbar-spacer" />
                <button
                  type="button"
                  className="primary mini"
                  disabled={judging || !statuses.every(s => s.settled)}
                  onClick={onJudge}
                  title={statuses.every(s => s.settled)
                    ? 'Run the compare judge over both final outputs'
                    : 'Both runs must settle before they can be judged'}
                >
                  {judging ? 'Judging…' : '⚖ Judge'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="compare-panes">
        {runIds.map((runId, i) => {
          const s = paneSnaps[i];
          const st = statuses[i];
          const meta = st.loaded ? s.meta : null;
          const items = st.loaded ? feedItems(s) : [];
          const gate = st.gated ? gateCopy(meta) : null;
          const questions = st.awaitingInput ? (meta?.pendingQuestions ?? []) : [];
          return (
            <section key={runId} className={'compare-pane' + (target === i ? ' targeted' : '')} aria-label={`Run ${paneLabel(i)}`}>
              <header className="compare-pane-head">
                <span className="compare-pane-badge">{paneLabel(i)}</span>
                <span
                  className="compare-pane-sigil"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: sigil(runId, 16) }}
                />
                <span className="compare-pane-name" title={runId}>
                  {meta?.name ?? meta?.flowName ?? 'Run'}
                </span>
                {meta?.modeName && <span className="mode-chip" title="Mode this run was launched with">{meta.modeName}</span>}
                {st.stage && <span className="stage-chip">{st.stage.replace(/_/g, ' ')}</span>}
                <div className="toolbar-spacer" />
                <button type="button" className="ghost mini" onClick={() => onOpenRun?.(runId)} title="Open this run full-screen in the Runs section">Open ↗</button>
              </header>

              {st.loaded ? (
                <>
                  <RunBar
                    snapshot={s}
                    onOpenFolder={() => onOpenFolder?.(runId)}
                    onPause={() => runControlFor(runId).pause()}
                    onResume={() => runControlFor(runId).resume()}
                    onStop={() => runControlFor(runId).stop()}
                    onSaveConfig={onSaveConfig}
                    onRematch={onRematch}
                  />

                  {/* Per-pane approval gate: a compact dock, never the blocking
                      modal — two full-surface modals would fight over the split.
                      Resolves this pane only; the sibling keeps running. */}
                  {gate && (
                    <div className={'gate-dock' + (gate.danger ? ' danger' : '')} role="status">
                      <span className="gate-dock-glyph" aria-hidden>{gate.danger ? '⚠' : '⏸'}</span>
                      <span className="gate-dock-text">
                        <strong>{gate.title}</strong>
                        {gate.kind === 'tool' && (
                          <span className="mono gate-dock-cmd" title={gate.tool.summary ?? undefined}>
                            {gate.tool.tool}{gate.tool.summary ? ` ${gate.tool.summary}` : ''}
                          </span>
                        )}
                        <span className="gate-dock-sub">Run {paneLabel(i)} is paused until you decide.</span>
                      </span>
                      <button className="primary" onClick={() => onApprove(runId)}>{gate.danger ? 'Approve anyway' : 'Approve'}</button>
                      <button className="reject" onClick={() => onReject(runId)}>Reject</button>
                    </div>
                  )}

                  {/* Per-pane refiner input gate: answered by targeting this pane
                      in the shared composer (the effect above pre-selects it). */}
                  {st.awaitingInput && (
                    <div className="input-gate" role="status">
                      <div className="input-gate-head">
                        <span className="input-gate-glyph" aria-hidden>✍</span>
                        <strong>Run {paneLabel(i)} needs a quick answer</strong>
                      </div>
                      <ol className="input-gate-questions">
                        {questions.map((q, qi) => (
                          <li key={q.id ?? qi}>
                            <span className="input-gate-q">{q.text}</span>
                            {q.why && <span className="input-gate-why">{q.why}</span>}
                            {q.options?.length > 0 && (
                              <span className="input-gate-options">
                                {q.options.map((o, oi) => (
                                  <span key={oi} className="input-gate-option is-static">{o}</span>
                                ))}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                      <span className="input-gate-hint">Reply to run {paneLabel(i)} below to continue.</span>
                    </div>
                  )}

                  <NodeFeed items={items} selectedNode={null} onSelect={() => {}} />
                </>
              ) : (
                <div className="chat-canvas chat-canvas-loading">
                  <span className="section-label">Starting run {paneLabel(i)}…</span>
                </div>
              )}
            </section>
          );
        })}
      </div>

      <div className="chat-composer compare-composer">
        <textarea
          ref={taRef}
          className="chat-input"
          placeholder={composerHint}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="Reply to the comparison"
          rows={2}
        />
        <button
          type="button"
          className="lander-run primary"
          onClick={submit}
          disabled={!canSend}
          title={plan.length === 0 ? 'Reply once a run settles' : `Send to ${targetLabel}`}
        >
          {sending ? 'Sending…' : `Send to ${targetLabel}`}<kbd className="shortcut">↵</kbd>
        </button>
      </div>
    </main>
  );
}
