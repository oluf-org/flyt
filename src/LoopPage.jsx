import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  pilesOf, burndown, flightRow, headline, tailLines, trendBars, taskDetail,
  PILE_ORDER, PILE_LABELS
} from './loopViewData.js';
import { ModelPicker } from './ModelPicker.jsx';

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

// The effort bands, cheapest first. Mirrored from core/levels.js rather than
// imported, for the reason every other constant in src/ is: the renderer does
// not import core, and this list changes about once a year.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// What a band with no model of its own inherits — the nearest one below it.
// Shown as the picker's placeholder so an empty row reads as "covered by that"
// rather than as "nothing will happen here".
function coverageFor(band, models = {}) {
  const i = LEVELS.indexOf(band);
  for (let j = i - 1; j >= 0; j--) if (models[LEVELS[j]]) return models[LEVELS[j]];
  // Nothing below: the lowest model set covers everything under it.
  for (const b of LEVELS) if (models[b]) return models[b];
  return null;
}

const describeModels = models => {
  const set = LEVELS.filter(b => models?.[b]);
  return set.length ? set.map(b => `${b}=${models[b]}`).join(', ') : null;
};

const sameModels = (a, b) => LEVELS.every(band => (a?.[band] ?? null) === (b?.[band] ?? null));

export default function LoopPage({ projectId, activeModels = [], onOpenRun = null }) {
  const [status, setStatus] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [caps, setCaps] = useState({});
  const [spend, setSpend] = useState(null);
  const [lines, setLines] = useState([]);
  const [series, setSeries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // The two models the loop uses (workers.loop, workers.reviewer). Kept in
  // settings rather than in this component's state, because the choice has to
  // outlive the window that made it — the loop's whole point is running when
  // nobody is looking at this page.
  const [workers, setWorkers] = useState({});
  // A model per effort band (LOOP-PLAN §8): the shape that makes a backlog
  // affordable, since only the tasks that fail climb into the dear one.
  const [levelModels, setLevelModels] = useState({});
  // Which task is open, and what the ledger says it spent. Fetched on expand
  // rather than for all forty rows: the queue is polled every three seconds and
  // a spend query per queued task would be forty reads a tick for numbers
  // nobody is looking at.
  const [openTask, setOpenTask] = useState(null);
  const [taskSpend, setTaskSpend] = useState({});
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

  // The saved model choices. Read once and after every save, not on the poll:
  // settings do not change underneath this page, and a picker whose value is
  // replaced every three seconds fights the person using it.
  const readWorkers = useCallback(async () => {
    const s = await window.flyt?.getSettings?.();
    setWorkers(s?.workers ?? {});
    setLevelModels(s?.loopModels ?? {});
  }, []);
  useEffect(() => { readWorkers().catch(() => {}); }, [readWorkers]);

  const setWorker = async (name, worker) => {
    setBusy(true);
    try {
      // A null clears the override: for `loop` that is "go back to effort
      // bands", for `reviewer` it is "nothing lands unattended".
      await window.flyt.setSettings({ workers: { [name]: worker } });
      await readWorkers();
      setError(null);
    } catch (err) { setError(String(err?.message ?? err)); }
    finally { setBusy(false); }
  };

  // One band's model. Saved whole rather than patched, the same shape
  // activeModels uses, so clearing one is simply its absence.
  const setLevelModel = async (band, model) => {
    const next = { ...levelModels };
    if (model) next[band] = model; else delete next[band];
    setBusy(true);
    try {
      await window.flyt.setSettings({ loopModels: next });
      await readWorkers();
      setError(null);
    } catch (err) { setError(String(err?.message ?? err)); }
    finally { setBusy(false); }
  };

  // One task's ledger line, fetched when it is opened.
  const openDetail = async task => {
    const next = openTask === task.id ? null : task.id;
    setOpenTask(next);
    if (!next || taskSpend[task.id] !== undefined) return;
    try {
      const totals = await window.flyt.ledgerTotals(projectId, { taskId: task.id });
      setTaskSpend(prev => ({ ...prev, [task.id]: totals }));
    } catch { setTaskSpend(prev => ({ ...prev, [task.id]: null })); }
  };

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
  // An unset worker arrives as `{ provider: null, model: null }` (config.json
  // declares both so they are settable while their unset state stays the
  // fail-closed one). The picker wants a plain null, which is what makes it
  // show its placeholder — "Effort bands", "No reviewer" — rather than a model.
  const asWorker = w => (w?.provider && w?.model ? w : null);
  const loopWorker = asWorker(workers.loop);
  const reviewerWorker = asWorker(workers.reviewer);

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
          {/* A loop this window did not start cannot be stopped from it — the
              supervisor lives in that other process. Saying where it is beats
              a Stop button that fails, or a Start button that would put a
              second picker on the same queue. */}
          {running && status?.observed
            ? <span className="loop-elsewhere" title={`Started by process ${status.pid}`}>
                running in another process
              </span>
            : running
              ? <button className="reject" disabled={busy} onClick={() => act(() => window.flyt.loopStop(projectId))}>Stop</button>
              : <button className="primary" disabled={busy} onClick={() => act(() => window.flyt.loopStart(projectId, {}))}>Start loop</button>}
          <button disabled={busy} onClick={() => act(async () => {
            const md = await window.flyt.loopReport(projectId);
            await navigator.clipboard?.writeText(md);
          })}>Copy report</button>
        </div>
      </header>

      {error && <div className="loop-error">{error}</div>}

      {/* The two models the loop runs on. They live here rather than only in
          Settings because this is where the decision is made — you choose a
          model in the same glance as pressing Start, and the consequence of
          each (what it costs, whether anything can land) belongs beside it. */}
      <section className="loop-models">
        <h2>Models</h2>
        {/* A model PER BAND, because that is the decision cost actually forces:
            something cheap does the ordinary work, and the expensive one is
            what a task reaches by FAILING — which is what the ladder already
            means. One model on every task is the bill nobody wanted. The map
            fills downward, so naming two bands answers all five. */}
        {LEVELS.map(band => {
          const id = levelModels[band] ?? null;
          const covered = coverageFor(band, levelModels);
          return (
            <div className="loop-model-row" key={band}>
              <label>{band}</label>
              <ModelPicker
                worker={id ? { provider: 'auto', model: id } : null}
                activeModels={activeModels}
                idPrefix={`loop-band-${band}`}
                placeholder={covered ? `↑ ${covered}` : 'Effort band'}
                onChange={w => setLevelModel(band, w?.model ?? null)}
              />
              {id && (
                <button type="button" className="link" disabled={busy} onClick={() => setLevelModel(band, null)}>
                  Clear
                </button>
              )}
            </div>
          );
        })}
        <p className="loop-model-note">
          {Object.keys(levelModels).length
            ? <>A task starts at its own band and moves up one on every failed attempt, so the
                dearer models are reached only by the work that needs them. Bands with no model of
                their own inherit the nearest one below.</>
            : <>No models named — each task asks OpenRouter's router for a cost tier instead, and a
                failed attempt retries one band up.</>}
        </p>
        <div className="loop-model-row">
          <label>Review</label>
          <ModelPicker
            worker={reviewerWorker}
            activeModels={activeModels}
            idPrefix="loop-review"
            placeholder="No reviewer"
            onChange={w => setWorker('reviewer', w)}
          />
          {reviewerWorker
            ? <button type="button" className="link" disabled={busy} onClick={() => setWorker('reviewer', null)}>
                Clear
              </button>
            : <span className="loop-model-hint warn">
                Nothing lands until a reviewer is set — the loop will run, verify and stop before
                merging.
              </span>}
        </div>
        {running && !sameModels(status?.models, levelModels) && (
          // A pick made after Start belongs to the next loop. Saying so beats a
          // panel that reports an intention as though it were what is running.
          <p className="loop-model-note warn">
            The running loop is on {describeModels(status?.models) ?? status?.model ?? 'effort bands'};
            this change applies when you start it again.
          </p>
        )}
      </section>

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
                <span className="level" title={row.model ? 'the model this attempt is running on' : 'the effort band this attempt asked for'}>
                  {row.model ?? row.level ?? ''}
                </span>
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
              {list.map(t => {
                const open = openTask === t.id;
                const detail = open ? taskDetail(t, { spend: taskSpend[t.id] ?? null }) : null;
                return (
                <article key={t.id} className={'loop-task' + (open ? ' open' : '')}>
                  {/* The head is the expander. A queue row that only shows a
                      title makes you go and read the file to answer "what is
                      this, actually" — which is the question the pile provokes
                      and the one it should answer itself. */}
                  {/* One row, two controls: the head expands, the source link
                      navigates. They are siblings rather than nested because a
                      button inside a button is neither valid nor clickable —
                      and the row keeps them on one line as before. */}
                  <div className="loop-task-row">
                    <button
                      type="button"
                      className="loop-task-head"
                      aria-expanded={open}
                      onClick={() => openDetail(t)}
                    >
                      <span className="caret" aria-hidden>{open ? '▾' : '▸'}</span>
                      <span className="id">{t.id}</span>
                      <span className="title">{t.title}</span>
                      {t.level && <span className="level">{t.level}</span>}
                      {t.attempts > 0 && <span className="attempts">{t.attempts} attempt(s)</span>}
                    </button>
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

                  {open && (
                    <div className="loop-task-detail">
                      {detail.facts.length > 0 && (
                        <dl className="loop-task-facts">
                          {detail.facts.map(f => (
                            <div key={f.label} title={f.title}>
                              <dt>{f.label}</dt><dd>{f.value}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {detail.lists.map(l => (
                        <div key={l.key} className="loop-task-list">
                          <span className="label">{l.label}</span>
                          {l.items.map(item => <code key={item} className="mono">{item}</code>)}
                        </div>
                      ))}
                      {detail.runIds.length > 0 && (
                        <div className="loop-task-list">
                          <span className="label">Runs</span>
                          {detail.runIds.map(id => (
                            <button key={id} type="button" className="link mono" onClick={() => onOpenRun?.(id)}>
                              {id}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* The task as its author wrote it. Not summarized: the
                          file is already written for a reader who has not seen
                          the run (§5.1). */}
                      {detail.body && <pre className="loop-task-body">{detail.body}</pre>}
                      {detail.empty && <p className="empty">Nothing recorded beyond the title.</p>}
                    </div>
                  )}

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
                );
              })}
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
