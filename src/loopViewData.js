// What the Loop view shows, as pure functions (LOOP-PLAN §14).
//
// The shaping lives here rather than in the component for the reason the rest
// of this codebase already follows (`src/nodeFeedData.js`, `src/runDocument.js`):
// a projection you can test is one you can trust, and every interesting
// decision in this panel is a projection — what counts as "needs you", where
// the burn-down sits, whether a task has been trying for too long.

// The piles, in the order a person actually cares about them at 18:00.
//
// "Waiting on you" first and always: it is the only part of this screen that is
// asking for something. Landed is reassurance, the queue is future work, and
// blocked is a diagnosis — none of them are a request.
export const PILE_ORDER = ['parked', 'landed', 'running', 'queued', 'failed'];

export const PILE_LABELS = {
  parked: 'Waiting on you',
  landed: 'Landed',
  running: 'In flight',
  queued: 'Queued',
  failed: 'Failed'
};

export function pilesOf(tasks = []) {
  const piles = Object.fromEntries(PILE_ORDER.map(k => [k, []]));
  for (const t of tasks) {
    // claimed/verifying/review are all "a worker has it" as far as a human
    // glancing at this screen is concerned.
    const key = ['claimed', 'verifying', 'review', 'running'].includes(t.status) ? 'running' : t.status;
    (piles[key] ??= []).push(t);
  }
  return piles;
}

/**
 * The burn-down against the caps (§9).
 *
 * Returns null when no cap is set, because a progress bar with no ceiling is a
 * decoration: it implies a limit that does not exist.
 */
export function burndown(spend, caps = {}) {
  const usd = spend?.usd ?? 0;
  const ceiling = caps.hardUsd ?? caps.softUsd ?? null;
  if (ceiling == null) return null;
  return {
    usd,
    ceiling,
    softUsd: caps.softUsd ?? null,
    pct: Math.min(100, (usd / ceiling) * 100),
    // Named states rather than a raw percentage, so the view does not have to
    // re-derive the same thresholds the supervisor already acts on.
    state: caps.hardUsd != null && usd >= caps.hardUsd ? 'stopped'
      : caps.softUsd != null && usd >= caps.softUsd ? 'capped'
        : 'ok',
    // An estimate presented as a measurement is a lie, and this is the number
    // someone will quote back at their bank statement.
    unknown: spend?.unknown ?? 0,
    estimated: spend?.estimated ?? 0
  };
}

const MIN = 60_000;

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}m`;
  const h = Math.floor(ms / (60 * MIN));
  const m = Math.round((ms % (60 * MIN)) / MIN);
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * One in-flight task as a row.
 *
 * `health` is the whole point of the row: a long task is fine and a stuck one
 * is not, so the panel must show the difference rather than showing a duration
 * and leaving the reader to guess (§11.2).
 */
export function flightRow(hb, { thresholds = {} } = {}) {
  const silentMs = thresholds.silentMs ?? 10 * MIN;
  const idle = hb.idleMs ?? 0;
  const health = hb.interventions?.length ? 'intervened'
    : idle >= silentMs ? 'stalled'
      : idle >= silentMs / 2 ? 'quiet'
        : 'working';
  return {
    taskId: hb.taskId,
    runId: hb.runId,
    level: hb.level ?? null,
    stage: hb.stage ?? hb.phase ?? 'running',
    age: humanDuration(hb.ageMs ?? 0),
    idle: humanDuration(idle),
    health,
    // What the supervisor has already tried, so a person can see it is being
    // handled rather than wondering whether to intervene themselves.
    interventions: hb.interventions ?? []
  };
}

// A one-line summary for the header: what the loop is doing right now, in the
// terms someone would ask about it.
export function headline({ status = {}, piles = {} }) {
  if (status.running) {
    const n = status.inFlight?.length ?? 0;
    return n ? `Working ${n} task${n === 1 ? '' : 's'}` : 'Waiting for something to pick up';
  }
  if (status.stopping) return `Stopped — ${status.stopping}`;
  const waiting = piles.parked?.length ?? 0;
  return waiting ? `Idle — ${waiting} waiting on you` : 'Idle';
}

/**
 * The benchmark trend across archived days (§14, §12.1).
 *
 * The panel's job is one sentence — "is this getting better" — so the shaping
 * refuses to answer it from a single point: one score is a measurement, and a
 * direction needs two. A day with no benchmark keeps its slot with a null bar
 * rather than being dropped, because a run of days where nobody scored anything
 * is itself the answer to why the number has not moved.
 */
export function trendBars(series, { limit = 14 } = {}) {
  const points = (series?.points ?? []).slice(-limit);
  const bars = points.map(p => ({
    date: p.date,
    label: String(p.date ?? '').slice(5), // MM-DD: the year is the same all day
    score: p.score,
    pct: p.score == null ? null : Math.round(p.score * 100),
    verified: p.verified,
    cases: p.cases,
    usd: p.benchUsd ?? null,
    scored: p.score != null
  }));
  const latest = series?.latest ?? null;
  return {
    bars,
    direction: series?.direction ?? null,
    latest,
    summary: !bars.length ? 'Nothing archived yet.'
      : !latest ? 'No day has been scored yet — run the benchmark to get a number to beat.'
        : `${(latest.score * 100).toFixed(0)}% on ${latest.date}`
          + (latest.cases ? ` (${latest.verified}/${latest.cases} cases)` : '')
          + (series.direction ? ` · ${series.direction}` : '')
  };
}

// Ring-buffer lines for the log tail, newest last, bounded for rendering.
export function tailLines(entries = [], limit = 200) {
  return entries.slice(-limit).map(e => ({
    at: e.at,
    time: String(e.at ?? '').slice(11, 19),
    line: e.line
  }));
}
