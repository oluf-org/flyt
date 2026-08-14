// The `loop` node (BRICKS P4.2 / D36 B10–B12): the doorway from a flow into
// the autonomous improvement loop D35 already built.
//
// It adds no autonomy. It enqueues the tasks a `backlog-plan` node produced,
// starts (or JOINS — one queue, one picker) the project's supervisor, and stays
// running until every task it queued is terminal. Its output is a report: what
// landed, what failed, what is waiting on you.
//
// The state is files (B12). A run that waits three days is legal and expected,
// so nothing is held in memory: the node's truth is the backlog's own status,
// re-derived on every poll and on reattach after a restart.

import fs from 'node:fs';
import path from 'node:path';
import { resolveDependsOn } from './backlogPlan.js';

export const WAIT_POLICIES = ['all', 'any', 'none'];
export const DEFAULT_POLL_MS = 5000;

const TERMINAL = new Set(['landed', 'failed']);

// --- the persisted record ---------------------------------------------------
// runs/<runId>/loop/<nodeId>.json. Written once at enqueue, read on reattach.
// Deliberately small: which task ids this node queued, and under what policy.
// Everything else is derived from the backlog, which is the only thing that
// stays true while the app is closed.

export const loopStatePath = (runDir, nodeId) =>
  path.join(runDir, 'loop', `${String(nodeId).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);

export function writeLoopState(runDir, nodeId, state) {
  const p = loopStatePath(runDir, nodeId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function readLoopState(runDir, nodeId) {
  try { return JSON.parse(fs.readFileSync(loopStatePath(runDir, nodeId), 'utf8')); }
  catch { return null; }
}

// --- enqueue ----------------------------------------------------------------

// Plan tasks -> real backlog entries, through Backlog.add (never by writing
// files: §5.2's rule about the canonical directory outside every worktree).
//
// Two passes, because dependsOn in the plan names another task by TITLE and the
// ids do not exist until add() allocates them.
export function enqueuePlan(backlog, tasks, { runId, nodeId, budgetUsd = null } = {}) {
  const byTitle = new Map();
  const created = [];
  for (const t of tasks) {
    const task = backlog.add({
      title: t.title,
      goal: t.goal,
      doneWhen: t.doneWhen,
      value: t.value,
      effort: t.effort,
      ...(t.level ? { level: t.level } : {}),
      gates: t.gates,
      blastRadius: t.blastRadius,
      ...(t.notes ? { notes: t.notes } : {}),
      ...(budgetUsd != null ? { budgetUsd } : {}),
      createdBy: 'flow',
      // P4.5: which run and which node put this here. The task parser
      // preserves unknown frontmatter fields, so this is additive by design —
      // an older reader keeps them, a newer one navigates by them.
      sourceRunId: runId,
      sourceNodeId: nodeId
    });
    byTitle.set(t.title, task.id);
    created.push({ plan: t, task });
  }
  // Second pass: now every title has an id.
  for (const { plan, task } of created) {
    const deps = resolveDependsOn(plan, byTitle);
    if (deps.length) backlog.update(task.id, { dependsOn: deps });
  }
  return created.map(c => c.task.id);
}

// --- waiting ----------------------------------------------------------------

// The live state of the tasks this node queued. Pure over a backlog snapshot,
// so the tests do not need a supervisor.
export function tallyTasks(tasks) {
  const by = { landed: [], failed: [], parked: [], inFlight: [], missing: [] };
  for (const t of tasks) {
    if (!t.task) { by.missing.push(t.id); continue; }
    const s = t.task.status;
    if (s === 'landed') by.landed.push(t.id);
    else if (s === 'failed') by.failed.push(t.id);
    else if (s === 'parked') by.parked.push(t.id);
    else by.inFlight.push(t.id);
  }
  return by;
}

// Is the node done waiting?
//
// B11: a PARKED task does not fail the node and does not end the wait — D35
// rule 7 says a gate parks a task and never blocks the loop, and the
// flow-level equivalent is that the node surfaces the park as a gate on itself
// and keeps waiting. A task that has vanished from the backlog (deleted by
// hand) counts as settled: waiting forever on a file nobody will recreate is
// not honesty, it is a hang.
export function isSettled(tally, waitFor) {
  if (waitFor === 'none') return true;
  const settled = tally.landed.length + tally.failed.length + tally.missing.length;
  if (waitFor === 'any') return settled > 0;
  return tally.inFlight.length === 0 && tally.parked.length === 0;
}

// --- the report -------------------------------------------------------------

export function renderLoopReport({ nodeTitle, taskIds, tasks, tally, waitFor, spend = null }) {
  const line = t => {
    const task = tasks.find(x => x.id === t)?.task;
    return task ? `- \`${t}\` — ${task.title}${task.blockedReason ? ` (${task.blockedReason})` : ''}` : `- \`${t}\` — (removed from the backlog)`;
  };
  const section = (heading, ids) => (ids.length ? [`## ${heading} (${ids.length})`, '', ...ids.map(line), ''] : []);
  return [
    `# ${nodeTitle} — ${taskIds.length} task(s) queued`,
    '',
    `Wait policy: \`${waitFor}\`.`
      + (spend ? ` Spend attributed to these tasks: $${spend.usd.toFixed(2)}`
        + (spend.unknown ? ` (plus ${spend.unknown} call(s) the ledger could not price)` : '') + '.' : ''),
    '',
    ...section('Landed', tally.landed),
    ...section('Failed', tally.failed),
    ...section('Waiting on you', tally.parked),
    ...section('Still running', tally.inFlight),
    ...(tally.missing.length ? section('Gone from the backlog', tally.missing) : []),
    tally.parked.length
      ? '> Parked tasks need a human. Answer them on the Loop page and the supervisor picks them back up.'
      : ''
  ].filter(l => l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// What this node's tasks have cost, from the ledger (P4.6). The ledger is the
// authority on spend; the node never counts tokens itself, and never invents a
// number when the ledger could not price a call.
//
// Q-B4, answered: ONE ledger is enough. A loop node's budgetUsd rides on the
// tasks it enqueues (Backlog's own per-task budgetUsd field), so the existing
// three ceilings — per task, rolling window, project — apply unchanged and a
// node cannot spend more than the project already allows. A separate worktree
// budget would be a fourth ceiling that agrees with the other three until the
// day it does not.
export function spendFor(ledger, taskIds) {
  if (!ledger?.totals) return null;
  try {
    let usd = 0;
    let unknown = 0;
    for (const id of taskIds) {
      const t = ledger.totals({ taskId: id });
      usd += t.usd ?? 0;
      unknown += t.unknown ?? 0;
    }
    return { usd: Number(usd.toFixed(6)), unknown };
  } catch { return null; }
}

export { TERMINAL };
