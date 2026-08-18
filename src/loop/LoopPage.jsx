import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { burndown, headline, tailLines, trendBars } from '../loopViewData.js';
import { columnsOf, boardBanner, filterTasks, moveCursor, allowedMoves } from '../loopBoardData.js';
import { applyPatch } from '../loopLive.js';
import Board from './Board.jsx';
import ModelBands, { sameModels } from './ModelBands.jsx';
import LoopChat from './LoopChat.jsx';

// The Loop view (LOOP-PLAN §14, rebuilt as a board in LOOP-BOARD §D).
//
// This is the human half of an unattended system. Its job is not to let you
// drive — the loop drives itself — but to answer three questions at a glance:
// what is moving, what is stuck, and what needs me. Everything on this page is
// subordinate to those, which is why the model pickers moved behind a
// disclosure: they are a decision made about once a week, and they were
// occupying the top third of a screen whose job is to show you work.
//
// Layout and wiring only. Every projection is in ../loopBoardData.js,
// ../loopLive.js and ../loopViewData.js, tested without a DOM.

const POLL_MS = 3000;

export default function LoopPage({ projectId, activeModels = [], onOpenRun = null }) {
  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [blockers, setBlockers] = useState({});
  const [boardLevel, setBoardLevel] = useState([]);
  const [problems, setProblems] = useState([]);
  const [caps, setCaps] = useState({});
  const [spend, setSpend] = useState(null);
  const [lines, setLines] = useState([]);
  const [series, setSeries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const [workers, setWorkers] = useState({});
  const [levelModels, setLevelModels] = useState({});

  const [openId, setOpenId] = useState(null);
  const [taskSpend, setTaskSpend] = useState({});
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(null);
  const [showDone, setShowDone] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  // The drawer is shared between the log and the chat, as two tabs of one
  // panel: they answer the same question from opposite ends — "what did it do"
  // and "what should it do next" — and two separate drawers would compete for
  // the same strip of screen.
  const [drawer, setDrawer] = useState('tail'); // 'tail' | 'chat' | null
  // Removal is the one action here that cannot be undone, so it asks twice.
  // `phase: 'force'` is the narrower case — the backlog refused because a
  // worker holds the lease — where the second press has to mean more.
  const [removeState, setRemoveState] = useState(null);

  // Every live run in this project, keyed by runId: { snapshot, rev }. ONE
  // subscription for the page, not one per expanded card — three cards
  // subscribing separately would be three copies of the same buffer.
  const [snapshots, setSnapshots] = useState(new Map());
  const snapsRef = useRef(snapshots);
  useEffect(() => { snapsRef.current = snapshots; }, [snapshots]);

  const tailRef = useRef(null);
  const filterRef = useRef(null);
  const boardRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!projectId || !window.flyt?.loopStatus) return;
    try {
      const [st, list, spendCheck, trend] = await Promise.all([
        window.flyt.loopStatus(projectId),
        window.flyt.listTasks(projectId),
        window.flyt.ledgerCheck(projectId).catch(() => null),
        // A project with no archive yet is the normal first-day state, not an
        // error worth colouring the whole panel red.
        window.flyt.archiveTrend?.(projectId).catch(() => null) ?? null
      ]);
      setStatus(st);
      setTasks(list?.tasks ?? []);
      setProblems(list?.problems ?? []);
      // Why each task is not moving, computed once on the backend in the same
      // module the supervisor's headline reads (LOOP-BOARD §B2).
      setBlockers(list?.blockers ?? {});
      setBoardLevel(list?.boardBlockers ?? []);
      setCaps(spendCheck?.caps ?? {});
      setSeries(trend);
      // The LEDGER is the source of truth for spend, not the supervisor's copy:
      // with no loop running the supervisor reports nothing, and a panel that
      // then shows $0.00 against a $4.00 cap is lying about the one number
      // someone will check against a bank statement.
      setSpend(spendCheck?.window ?? st?.spend ?? null);
      setError(null);
    } catch (err) {
      // A project with no folder has no backlog and no ledger, which is a
      // legitimate state rather than a failure — say so instead of showing an
      // empty panel that looks broken.
      setError(String(err?.message ?? err));
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The saved model choices. Read once and after every save, not on the poll:
  // settings do not change underneath this page, and a picker whose value is
  // replaced every three seconds fights the person using it.
  const readWorkers = useCallback(async () => {
    const s = await window.flyt?.getSettings?.();
    setWorkers(s?.workers ?? {});
    setLevelModels(s?.loopModels ?? {});
  }, []);
  useEffect(() => { readWorkers().catch(() => {}); }, [readWorkers]);

  // The log tail, live.
  useEffect(() => {
    if (!projectId) return undefined;
    window.flyt?.loopLog?.(projectId).then(entries => setLines(tailLines(entries))).catch(() => {});
    return window.flyt?.onLoopEvent?.(entry => {
      if (entry.projectId !== projectId) return;
      setLines(prev => tailLines([...prev, entry]));
    });
  }, [projectId]);

  /**
   * The run snapshots behind the Working column.
   *
   * The data has been on the wire the whole time — a loop worker's run is an
   * ordinary run, and core/engine.js already pushes `run:update` for every run
   * in the project. This page simply was not listening.
   */
  useEffect(() => {
    if (!projectId || !window.flyt?.onRunUpdate) return undefined;
    return window.flyt.onRunUpdate(payload => {
      if (payload.projectId && payload.projectId !== projectId) return;
      const runId = payload.runId;
      const held = snapsRef.current.get(runId);
      // Only runs this page is actually watching. Everything else on the wire
      // belongs to the run view, and mirroring it here would be a second copy
      // of every buffer in the app.
      if (!held) return;
      const next = applyPatch(held, payload);
      if (next.refetch) {
        window.flyt.getSnapshot(projectId, runId)
          .then(s => setSnapshots(prev => new Map(prev).set(runId, { snapshot: s, rev: s.rev ?? 0 })))
          .catch(() => {});
        return;
      }
      setSnapshots(prev => new Map(prev).set(runId, next));
    });
  }, [projectId]);

  // Fetch a snapshot when a worker card is expanded, and drop it when it is
  // collapsed — that is what makes "collapsing stops the work" true.
  useEffect(() => {
    if (!projectId) return;
    const runId = status?.inFlight?.find(h => h.taskId === openId)?.runId ?? null;
    if (!runId) return;
    if (snapsRef.current.has(runId)) return;
    window.flyt.getSnapshot(projectId, runId)
      .then(s => setSnapshots(prev => new Map(prev).set(runId, { snapshot: s, rev: s.rev ?? 0 })))
      .catch(() => {});
  }, [projectId, openId, status]);

  useEffect(() => {
    const watched = status?.inFlight?.find(h => h.taskId === openId)?.runId ?? null;
    setSnapshots(prev => {
      if (!prev.size) return prev;
      const next = new Map([...prev].filter(([runId]) => runId === watched));
      return next.size === prev.size ? prev : next;
    });
  }, [openId, status]);

  // Pin the tail to the bottom, the way a log is read.
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const visible = useMemo(() => filterTasks(tasks, query, blockers), [tasks, query, blockers]);
  const columns = useMemo(
    () => columnsOf(visible, blockers, { problems: query ? [] : problems, showDone }),
    [visible, blockers, problems, showDone, query]
  );
  const tasksById = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const banner = useMemo(() => boardBanner(boardLevel), [boardLevel]);
  // `headline()` returns one sentence, and its `Stopped — <reason>` branch can
  // be a paragraph: the supervisor's reason names tasks and what they wait on.
  // Two wrapped lines of it clipped with an ellipsis is the worst of both, so
  // the STATE stays the heading and the reason drops to the line below, where
  // there is room for it — and where the eye already goes for detail.
  const [headState, headWhy] = splitHeadline(headline({
    status: status ?? {},
    piles: { parked: columns.find(c => c.id === 'needs-you')?.cards ?? [] }
  }));
  const burn = burndown(spend, caps);
  const trend = series ? trendBars(series) : null;
  const running = Boolean(status?.running);

  // An unset worker arrives as `{ provider: null, model: null }` (config.json
  // declares both so they are settable while their unset state stays the
  // fail-closed one). The picker wants a plain null.
  const asWorker = w => (w?.provider && w?.model ? w : null);

  const act = async fn => {
    setBusy(true);
    try { await fn(); await refresh(); setError(null); }
    catch (err) { setError(String(err?.message ?? err)); throw err; }
    finally { setBusy(false); }
  };
  const quiet = fn => act(fn).catch(() => {});

  const setWorker = (name, worker) => quiet(async () => {
    await window.flyt.setSettings({ workers: { [name]: worker } });
    await readWorkers();
  });

  const setLevelModel = (band, model) => quiet(async () => {
    const next = { ...levelModels };
    if (model) next[band] = model; else delete next[band];
    await window.flyt.setSettings({ loopModels: next });
    await readWorkers();
  });

  const toggle = async id => {
    const next = openId === id ? null : id;
    setOpenId(next);
    setCursor(prev => (next ? { column: prev?.column ?? null, id: next } : prev));
    if (!next || taskSpend[next] !== undefined) return;
    // One task's ledger line, fetched on expand rather than for all forty rows:
    // the queue is polled every three seconds and a spend query per queued task
    // would be forty reads a tick for numbers nobody is looking at.
    try {
      const totals = await window.flyt.ledgerTotals(projectId, { taskId: next });
      setTaskSpend(prev => ({ ...prev, [next]: totals }));
    } catch { setTaskSpend(prev => ({ ...prev, [next]: null })); }
  };

  /**
   * Every action on a card goes through here, and every one of them came from
   * `allowedMoves` — so a button, a keyboard shortcut and a remedy all obey the
   * same table and none of them can invent a transition the backlog would
   * refuse.
   */
  const move = async (id, m) => {
    if (m.action === 'remove') return removeFlow(id, m);
    const call = {
      'task:release': () => window.flyt.releaseTask(projectId, id, m.to ?? 'queued'),
      'task:escalate': () => window.flyt.escalateTask(projectId, id, 'stalled'),
      'task:update': () => window.flyt.updateTask(projectId, id, m.patch ?? m.remedy?.args ?? {}),
      'loop:start': () => window.flyt.loopStart(projectId, {})
    }[m.command];
    if (!call) return;
    await quiet(call);
  };

  /**
   * Removal: one press to ask, one to mean it.
   *
   * The refusal path is the interesting one. A claimed task is refused by the
   * backlog because a worker holds the lease and probably a worktree, and the
   * honest answer is not to hide the button but to say what is in the way and
   * let the second press mean it.
   */
  const removeFlow = async (id, m) => {
    if (m.phase === 'cancel') { setRemoveState(null); return; }
    if (m.phase === 'ask') { setRemoveState({ id, phase: 'ask' }); return; }
    setBusy(true);
    try {
      await window.flyt.removeTask(projectId, id, Boolean(m.force));
      setRemoveState(null);
      if (openId === id) setOpenId(null);
      setError(null);
      await refresh();
    } catch (err) {
      const msg = String(err?.message ?? err);
      setError(msg);
      if (/claimed/i.test(msg)) setRemoveState({ id, phase: 'force' });
      else setRemoveState(null);
    } finally { setBusy(false); }
  };

  // A remedy button. Most map to a command; the few that do not are decisions a
  // person makes elsewhere on this page, so they open the place to make them.
  const remedy = async (r, id = null) => {
    if (r.action === 'set-reviewer' || r.action === 'set-model') { setShowModels(true); return; }
    if (r.action === 'open-task') { setOpenId(r.args?.id ?? id); return; }
    if (r.action === 'start-loop') { await quiet(() => window.flyt.loopStart(projectId, {})); return; }
    if (r.action === 'raise-cap' || r.action === 'raise-parallelism') {
      // These live in the project's own config file, which this page does not
      // own. Saying where beats a button that silently does nothing.
      setError(`Change ${r.action === 'raise-cap' ? 'the spending caps' : 'loop.parallelism'} in this project's .flyt/config.json.`);
      return;
    }
    if (r.action === 'break-cycle') {
      const task = tasksById.get(r.args.id);
      await quiet(() => window.flyt.updateTask(projectId, r.args.id, {
        dependsOn: (task?.dependsOn ?? []).filter(d => d !== r.args.drop)
      }));
      return;
    }
    if (r.action === 'remove-dep') {
      await quiet(() => window.flyt.updateTask(projectId, r.args.id, { dependsOn: r.args.dependsOn ?? [] }));
      return;
    }
    if (r.action === 'release-task' || r.action === 'requeue') {
      await quiet(() => window.flyt.releaseTask(projectId, r.args.id ?? id, 'queued'));
      return;
    }
    if (r.action === 'requeue-up') { await quiet(() => window.flyt.escalateTask(projectId, r.args.id ?? id, 'stalled')); return; }
    if (r.action === 'remove-task') { setRemoveState({ id: r.args.id ?? id, phase: 'ask' }); return; }
    if (r.action === 'edit-gates') { setOpenId(r.args.id ?? id); return; }
  };

  /**
   * Answering a question an agent asked (`ask_human`).
   *
   * The answer goes into the task BODY, so the next attempt reads it as part of
   * the brief rather than as a note somewhere off to the side — and the task is
   * requeued, which is the whole point: three attempts guessing at an ambiguity
   * become one attempt that knows the answer.
   */
  const answer = (id, text) => quiet(async () => {
    const task = tasksById.get(id);
    const body = [task?.body ?? '', '', '## Answer from the person who owns this project', '', text].join('\n').trim();
    await window.flyt.updateTask(projectId, id, { body, blockedReason: '' });
    await window.flyt.releaseTask(projectId, id, 'queued');
  });

  // --- keyboard (§D4) ------------------------------------------------------
  useEffect(() => {
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? '');
      if (e.key === '/' && !inField) { e.preventDefault(); filterRef.current?.focus(); return; }
      if (e.key === 'Escape') {
        if (inField) { e.target.blur(); return; }
        setOpenId(null);
        return;
      }
      if (inField) return;
      const dir = { j: 'down', k: 'up', h: 'left', l: 'right' }[e.key];
      if (dir) { e.preventDefault(); setCursor(prev => moveCursor(columns, prev, dir)); return; }
      if (!cursor?.id) return;
      if (e.key === 'Enter') { e.preventDefault(); toggle(cursor.id); return; }
      const wanted = { r: 'requeue', x: 'remove' }[e.key];
      if (!wanted) return;
      // Through allowedMoves, so a shortcut can never do something a button
      // would have refused.
      const task = tasksById.get(cursor.id);
      const m = allowedMoves(task ?? {}, { blockers: blockers[cursor.id] ?? [] })
        .find(x => x.action === wanted);
      if (!m) return;
      e.preventDefault();
      move(cursor.id, m.action === 'remove' ? { ...m, phase: 'ask' } : m);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [columns, cursor, tasksById, blockers]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="loop-page" ref={boardRef}>
      {/* One strip: what it is doing, the controls, the money, the score.
          Everything that was five stacked sections is now one line of chrome
          above a board, because the board is the page. */}
      <header className="loop-head">
        <div className="loop-head-main">
          <h1>{headState}</h1>
          <p className="loop-sub" title={headWhy ?? undefined}>
            {headWhy && <span className="why">{headWhy}</span>}
            {status
              ? `${status.landed ?? 0} of ${status.completed ?? 0} attempt(s) landed`
                + (status.noEscalate ? ' · soft cap reached, not escalating' : '')
              : 'Not started'}
          </p>
        </div>

        {burn && (
          <div className={`loop-burn-inline loop-burn-${burn.state}`} title={
            burn.unknown ? `${burn.unknown} call(s) reported no cost` : 'spend against the cap'
          }>
            <span className="meter"><span style={{ width: `${burn.pct}%` }} /></span>
            <span className="label">${burn.usd.toFixed(2)} / ${burn.ceiling.toFixed(2)}</span>
          </div>
        )}

        {trend && trend.bars.length > 0 && (
          <div className="loop-spark" title={trend.summary}>
            {trend.bars.map(b => (
              <span key={b.date} className={b.scored ? '' : 'unscored'} style={{ height: `${b.pct ?? 4}%` }} />
            ))}
          </div>
        )}

        <div className="loop-actions">
          {/* A loop this window did not start cannot be stopped from it — the
              supervisor lives in that other process. Saying where it is beats a
              Stop button that fails. */}
          {running && status?.observed && (
            <span className="loop-elsewhere" title={`Started by process ${status.pid}`}>elsewhere</span>
          )}
          {running
            // Stop works either way: for a loop this window owns it is direct,
            // and for one it is only watching it leaves a request the loop reads
            // on its next poll — which winds down cleanly, where killing the
            // process would leave a worktree, a claimed task and possibly a
            // half-landed merge behind.
            ? <button className="reject" disabled={busy} onClick={() => quiet(() => window.flyt.loopStop(projectId))}>Stop</button>
            : <button className="primary" disabled={busy} onClick={() => quiet(() => window.flyt.loopStart(projectId, {}))}>Start loop</button>}
          <button disabled={busy} onClick={() => quiet(async () => {
            const md = await window.flyt.loopReport(projectId);
            await navigator.clipboard?.writeText(md);
          })}>Copy report</button>
          <button
            className={showModels ? 'active' : ''}
            aria-expanded={showModels}
            onClick={() => setShowModels(v => !v)}
          >Models</button>
        </div>
      </header>

      {error && <div className="loop-error" role="alert">{error}</div>}

      {showModels && (
        <section className="loop-models">
          <ModelBands
            levelModels={levelModels}
            reviewerWorker={asWorker(workers.reviewer)}
            activeModels={activeModels}
            status={status}
            running={running}
            busy={busy}
            onSetLevelModel={setLevelModel}
            onSetWorker={setWorker}
          />
        </section>
      )}

      <div className="loop-filter">
        <input
          ref={filterRef}
          type="search"
          value={query}
          placeholder="Filter — is:blocked  level:high  dep:t-0006  gate:&quot;npm test&quot;"
          aria-label="Filter tasks"
          onChange={e => setQuery(e.target.value)}
        />
        {query && <button className="link" onClick={() => setQuery('')}>clear</button>}
        {/* A row of bare letters — "j k h l · enter · r · x · /" — reads as
            noise, not as an offer. Behind a "?" it is discoverable when you
            want it and silent when you do not. */}
        <button
          type="button"
          className="loop-keys-toggle"
          aria-expanded={showKeys}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts"
          onClick={() => setShowKeys(v => !v)}
        >?</button>
      </div>

      {showKeys && (
        <dl className="loop-keys">
          {[['j k', 'move down / up'], ['h l', 'previous / next column'], ['⏎', 'open the card'],
            ['r', 'requeue'], ['x', 'remove (asks twice)'], ['/', 'filter'], ['esc', 'collapse']].map(([k, what]) => (
            <div key={k}><dt>{k}</dt><dd>{what}</dd></div>
          ))}
        </dl>
      )}

      <Board
        columns={columns}
        banner={banner}
        tasksById={tasksById}
        heartbeats={status?.inFlight ?? []}
        snapshots={snapshots}
        openId={openId}
        cursor={cursor}
        busy={busy}
        projectId={projectId}
        spend={taskSpend}
        removeState={removeState}
        showDone={showDone}
        onToggleDone={() => setShowDone(v => !v)}
        onToggle={toggle}
        onMove={move}
        onRemedy={remedy}
        onAnswer={answer}
        onOpenRun={onOpenRun}
        onOpenTask={id => { setOpenId(id); setCursor({ column: null, id }); }}
      />

      {/* A drawer rather than two sections: the log is what you read when
          something has gone wrong, and the chat is what you use when you know
          what should happen next. Neither is the thing you read first. */}
      <section className={`loop-drawer${drawer ? ' open' : ''}`}>
        <div className="loop-drawer-tabs" role="tablist">
          {[['tail', 'What it did'], ['chat', 'Ask']].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={`loop-drawer-tab${drawer === id ? ' active' : ''}`}
              aria-expanded={drawer === id}
              aria-selected={drawer === id}
              onClick={() => setDrawer(prev => (prev === id ? null : id))}
            >
              <span className="caret" aria-hidden>{drawer === id ? '▾' : '▸'}</span> {label}
            </button>
          ))}
        </div>
        {drawer === 'tail' && (
          <div className="loop-tail-lines" ref={tailRef}>
            {!lines.length && <p className="empty">Nothing yet.</p>}
            {lines.map((l, i) => (
              <div key={`${l.at}-${i}`} className="loop-tail-line">
                <span className="time">{l.time}</span>
                <span className="text">{l.line}</span>
              </div>
            ))}
          </div>
        )}
        {drawer === 'chat' && (
          <LoopChat
            projectId={projectId}
            activeModels={activeModels}
            boardBlockers={boardLevel}
            onOpenTask={id => { setOpenId(id); setCursor({ column: null, id }); }}
          />
        )}
      </section>
    </div>
  );
}

/**
 * "Stopped — nothing ready — 1 task(s) blocked: t-0008 (…)" → the state and the
 * reason, separately.
 *
 * Split here rather than in `headline()` because it is a layout decision — the
 * projection's job is to produce the sentence, and a caller that wants it whole
 * (the report, the CLI) should keep getting it whole.
 */
export function splitHeadline(line) {
  const at = String(line ?? '').indexOf(' — ');
  return at === -1 ? [line, null] : [line.slice(0, at), line.slice(at + 3)];
}

export { sameModels };
