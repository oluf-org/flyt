// The runs list's derived data: which date bucket a run falls in, how its time
// reads, and what its stage means as a status. Pure over the run summaries
// RunStore.runSummaries() hands the renderer, so it tests without a DOM — same
// split as runProgress.js / runGraph.js.
import { isTerminal } from './runProgress.js';

const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map(m => m.slice(0, 3));

// Undated runs (unparseable createdAt) sort last and bucket together rather
// than landing in an arbitrary month.
const timeOf = run => {
  const t = Date.parse(run?.createdAt ?? '');
  return Number.isFinite(t) ? t : -Infinity;
};

const startOfDay = ms => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Buckets are calendar-relative in the viewer's own timezone: "Today" has to
// mean the user's today, not UTC's — a run at 01:00 local is today even when
// its stored ISO instant is still yesterday in UTC.
function bucketFor(t, now) {
  if (!Number.isFinite(t)) return { key: 'undated', label: 'Undated' };
  const day = startOfDay(t);
  const today = startOfDay(now);
  if (day >= today) return { key: 'today', label: 'Today' };          // >=: a clock-skewed future run reads as today
  if (day >= today - DAY) return { key: 'yesterday', label: 'Yesterday' };
  if (day > today - 7 * DAY) return { key: 'week', label: 'Previous 7 days' };
  if (day > today - 30 * DAY) return { key: 'month', label: 'Previous 30 days' };
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return {
    key: `m-${d.getFullYear()}-${d.getMonth()}`,
    label: sameYear ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
  };
}

// Runs newest-first, split into date sections in that same order. Sorts its own
// input: the grouping must not depend on the caller having sorted first.
export function groupRuns(runs, now = Date.now()) {
  const groups = new Map();
  for (const run of [...(runs ?? [])].sort((a, b) => timeOf(b) - timeOf(a))) {
    const { key, label } = bucketFor(timeOf(run), now);
    if (!groups.has(key)) groups.set(key, { key, label, runs: [] });
    groups.get(key).runs.push(run);
  }
  return [...groups.values()];
}

// Time-of-day for runs whose section already gives the date; a date for the
// rest. Never repeats what the section header just said.
export function runTimeLabel(run, now = Date.now()) {
  const t = timeOf(run);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  if (startOfDay(t) >= startOfDay(now) - DAY) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return d.getFullYear() === new Date(now).getFullYear()
    ? `${SHORT[d.getMonth()]} ${d.getDate()}`
    : `${SHORT[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// The full instant, for the hover title — the list itself stays terse.
export function runTimeTitle(run) {
  const t = timeOf(run);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : 'Unknown time';
}

const TERMINAL_LABEL = {
  done: 'Done', failed: 'Failed', rejected: 'Rejected', stopped: 'Stopped', interrupted: 'Interrupted'
};
const STAGE_LABEL = {
  prompt: 'Queued',
  planning: 'Planning',
  awaiting_approval: 'Needs approval',
  // A run parked on a question is not running, and reading "Running" is how it
  // gets left alone: the list is where you scan for what needs you, and the one
  // stage that literally cannot proceed without you looked identical to the
  // ones that are working. Seen on a real list of ninety runs.
  awaiting_input: 'Needs an answer',
  routing: 'Routing',
  execution: 'Running',
  resumed: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  stopping: 'Stopping',
  verification: 'Verifying'
};

// Stage → the one word the list shows plus the dot's class. Terminal stages win
// over `interrupted`: a run that was interrupted and then resumed to completion
// is Done, and the flag only still describes runs that never got there.
// A user-stopped run (RUN-CONTROL 'cancelled') reads like an interruption, not
// a failure — its finished work is kept, and it can be restarted or branched.
export function runStatus(run) {
  if (run?.lifecycle?.phase === 'settled') {
    if (run.lifecycle.cleanup === 'failed') return { kind: 'failed', label: 'Cleanup needs attention' };
    if (['pending', 'running'].includes(run.lifecycle.cleanup)) return { kind: 'paused', label: 'Finishing cleanup' };
  }
  const stage = run?.stage;
  if (stage === 'cancelled') return { kind: 'interrupted', label: 'Stopped' };
  if (stage === 'stopped' || stage === 'interrupted') {
    return { kind: 'interrupted', label: TERMINAL_LABEL[stage] };
  }
  if (isTerminal(stage)) return { kind: stage, label: TERMINAL_LABEL[stage] ?? 'Done' };
  if (run?.interrupted) return { kind: 'interrupted', label: 'Interrupted' };
  if (stage === 'awaiting_approval' || stage === 'awaiting_input' || stage === 'paused') {
    return { kind: 'waiting', label: STAGE_LABEL[stage] };
  }
  return { kind: 'running', label: STAGE_LABEL[stage] ?? 'Running' };
}
