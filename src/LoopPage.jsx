import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  pilesOf, burndown, flightRow, headline, tailLines, trendBars, PILE_ORDER, PILE_LABELS
} from './loopViewData.js';

// The Loop view (LOOP-PLAN §14): what the supervisor is doing, what it wants
// from you, and what it has spent.
//
// This is the human half of an unattended system, and its job is not to let you
// drive — the loop drives itself — but to answer three questions at a glance:
// is it stuck, does it need me, and what is this costing. Everything else on
// the page is subordinate to those.
//
// The shaping is all in loopViewData.js so it can be tested; this file is
// layout and wiring.

const HEALTH_GLYPH = { working: '◆', quiet: '◇', stalled: '▲', intervened: '⟳' };

export default function LoopPage({ projectId, onOpenRun = null }) {
  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [caps, setCaps] = useState({});
  const [spend, setSpend] = useState(null);
  const [lines, setLines] = useState([]);
  const [series, setSeries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const tailRef = useRef(null);

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
      setCaps(spendCheck?.caps ?? {});
      setSeries(trend);
      // The LEDGER is the source of truth for spend, not the supervisor's copy
      // of it: with no loop running the supervisor reports nothing, and a panel
      // that then shows $0.00 against a $4.00 cap is lying about the one number
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

  // Poll for the piles (files change underneath us) and take the log live.
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!projectId) return undefined;
    window.flyt?.loopLog?.(projectId).then(entries => setLines(tailLines(entries))).catch(() => {});
    return window.flyt?.onLoopEvent?.(entry => {
      if (entry.projectId !== projectId) return;
      setLines(prev => tailLines([...prev, entry]));
    });
  }, [projectId]);

  // Pin the tail to the bottom, the way a log is read.
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const piles = pilesOf(tasks);
  const burn = burndown(spend, caps);
  const trend = series ? trendBars(series) : null;
  const running = Boolean(status?.running);

  const act = async fn => {
    setBusy(true);
    try { await fn(); await refresh(); }
    catch (err) { setError(String(err?.message ?? err)); }
    finally { setBusy(false); }
  };

  return (
    <div className="loop-page">
      <header className="loop-head">
        <div>
          <h1>{headline({ status: status ?? {}, piles })}</h1>
          <p className="loop-sub">
            {status
              ? `${status.landed ?? 0} of ${status.completed ?? 0} attempt(s) landed`
                + (status.noEscalate ? ' · soft cap reached, not escalating' : '')
              : 'Not started'}
          </p>
        </div>
        <div className="loop-actions">
          {running
            ? <button className="reject" disabled={busy} onClick={() => act(() => window.flyt.loopStop(projectId))}>Stop</button>
            : <button className="primary" disabled={busy} onClick={() => act(() => window.flyt.loopStart(projectId, {}))}>Start loop</button>}
          <button disabled={busy} onClick={() => act(async () => {
            const md = await window.flyt.loopReport(projectId);
            await navigator.clipboard?.writeText(md);
          })}>Copy report</button>
        </div>
      </header>

      {error && <div className="loop-error">{error}</div>}

      {burn && (
        <section className={`loop-burn loop-burn-${burn.state}`}>
          <div className="loop-burn-bar"><span style={{ width: `${burn.pct}%` }} /></div>
          <div className="loop-burn-label">
            <strong>${burn.usd.toFixed(2)}</strong> of ${burn.ceiling.toFixed(2)}
            {burn.state === 'capped' && ' · soft cap reached'}
            {burn.state === 'stopped' && ' · hard cap reached'}
            {/* An estimate shown as a measurement is a lie, and this is the
                number someone will compare against a bank statement. */}
            {burn.unknown > 0 && <em> · {burn.unknown} call(s) with no cost reported</em>}
          </div>
        </section>
      )}

      {status?.inFlight?.length > 0 && (
        <section className="loop-flight">
          <h2>In flight</h2>
          {status.inFlight.map(hb => {
            const row = flightRow(hb);
            return (
              <div key={row.taskId} className={`loop-flight-row health-${row.health}`}>
                <span className="glyph" title={row.health}>{HEALTH_GLYPH[row.health] ?? '◆'}</span>
                <span className="id">{row.taskId}</span>
                <span className="stage">{row.stage}</span>
                <span className="level">{row.level ?? ''}</span>
                <span className="age">{row.age}</span>
                <span className="idle" title="since anything last changed">idle {row.idle}</span>
                {row.interventions.length > 0 && (
                  <span className="interventions" title="what the supervisor already tried">
                    {row.interventions.join(' → ')}
                  </span>
                )}
              </div>
            );
          })}
        </section>
      )}

      <div className="loop-piles">
        {PILE_ORDER.map(key => {
          const list = piles[key] ?? [];
          if (!list.length && key !== 'parked') return null;
          return (
            <section key={key} className={`loop-pile loop-pile-${key}`}>
              <h2>{PILE_LABELS[key]} <span className="count">{list.length}</span></h2>
              {!list.length && <p className="empty">Nothing waiting on you.</p>}
              {list.map(t => (
                <article key={t.id} className="loop-task">
                  <div className="loop-task-head">
                    <span className="id">{t.id}</span>
                    <span className="title">{t.title}</span>
                    {t.level && <span className="level">{t.level}</span>}
                    {t.attempts > 0 && <span className="attempts">{t.attempts} attempt(s)</span>}
                    {/* Where this task came from (D36 P4.5). A task a flow
                        queued is otherwise indistinguishable from one a human
                        typed, and "why is this here" is the first question the
                        parked pile provokes. */}
                    {t.sourceRunId && (
                      <button
                        type="button"
                        className="link mono source-run"
                        title={`Queued by the "${t.sourceNodeId ?? 'loop'}" node of run ${t.sourceRunId}`}
                        onClick={() => onOpenRun?.(t.sourceRunId)}
                      >← {t.sourceNodeId ?? 'flow'}</button>
                    )}
                  </div>
                  {/* The reason is the point of the parked pile: a task that
                      needs you without saying why is a task you cannot act on. */}
                  {t.blockedReason && <p className="reason">{t.blockedReason}</p>}
                  {key === 'parked' && (
                    <div className="loop-task-actions">
                      <button disabled={busy} onClick={() => act(() => window.flyt.releaseTask(projectId, t.id, 'queued'))}>
                        Requeue
                      </button>
                      <button disabled={busy} onClick={() => act(() => window.flyt.escalateTask(projectId, t.id, 'stalled'))}>
                        Requeue a level up
                      </button>
                    </div>
                  )}
                </article>
              ))}
            </section>
          );
        })}
      </div>

      {/* The benchmark trend (§12.1): the only thing on this page that answers
          "is it getting better" rather than "what is it doing". Rendered even
          with nothing scored yet, because the absence is the prompt to run it. */}
      {trend && trend.bars.length > 0 && (
        <section className="loop-trend">
          <h2>Benchmark <span className="count">{trend.summary}</span></h2>
          <div className="loop-trend-bars">
            {trend.bars.map(b => (
              <div key={b.date} className={`loop-trend-bar${b.scored ? '' : ' unscored'}`}
                title={b.scored ? `${b.date}: ${b.verified}/${b.cases} verified${b.usd != null ? `, $${b.usd.toFixed(2)}` : ''}` : `${b.date}: not scored`}>
                <span className="fill" style={{ height: `${b.pct ?? 0}%` }} />
                <span className="tick">{b.label}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="loop-tail">
        <h2>What it did</h2>
        <div className="loop-tail-lines" ref={tailRef}>
          {!lines.length && <p className="empty">Nothing yet.</p>}
          {lines.map((l, i) => (
            <div key={`${l.at}-${i}`} className="loop-tail-line">
              <span className="time">{l.time}</span>
              <span className="text">{l.line}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
