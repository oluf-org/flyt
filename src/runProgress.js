// Run-level progress for the run view (V1 task 9): the few numbers that answer
// "how far along is this, and is it still moving?" without counting glyphs on
// the canvas or opening the run folder. Pure over a run snapshot, so it tests
// without a DOM — same split as flowTypes.js / runStreams.js.

// Mirrors TERMINAL_STAGES in core/stackRunner.js (RUN-CONTROL added 'cancelled':
// a stopped run is done moving, and its finished nodes stay inspectable).
// Duplicated rather than imported: that module reaches node:fs through its
// adapter/tool imports, and this one runs in the renderer.
const TERMINAL = new Set(['done', 'failed', 'rejected', 'cancelled']);

export const isTerminal = stage => TERMINAL.has(stage);

// `now` is injectable so the elapsed clock is testable.
export function runProgress(snapshot, now = Date.now()) {
  const meta = snapshot?.meta;
  const nodes = snapshot?.flow?.nodes;
  if (!meta || !nodes) return null;

  // Count over flow.nodes rather than the nodeStatus keys: nodes materialized
  // mid-run (plan-eval, orchestrator children) join the flow before they get a
  // status entry, and counting keys would silently undercount the denominator.
  const count = {};
  for (const n of nodes) {
    const s = meta.nodeStatus?.[n.id] ?? 'pending';
    count[s] = (count[s] ?? 0) + 1;
  }

  const live = !isTerminal(meta.stage);
  const started = Date.parse(meta.createdAt);
  const stopped = Date.parse(meta.updatedAt ?? '');
  // A finished run's clock stops at its last write; a live one runs to `now`.
  const end = live ? now : (Number.isFinite(stopped) ? stopped : now);
  const elapsedMs = Number.isFinite(started) ? Math.max(0, end - started) : null;

  return {
    total: nodes.length,
    done: count.done ?? 0,
    active: count.active ?? 0,
    waiting: count.waiting ?? 0,
    failed: count.failed ?? 0,
    live,
    elapsedMs,
    // Tasks an agent spawned run *inside* their owning node, so they are work
    // the node count cannot see. Surfaced separately rather than inflating the
    // denominator, which would make the bar jump backwards mid-run.
    tasksRunning: (snapshot.tasks?.tasks ?? []).filter(t => t.status === 'running').length
  };
}

export function formatElapsed(ms) {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  const pad = n => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  return h > 0
    ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}
