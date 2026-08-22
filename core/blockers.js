// Why a task is not moving — one module, one vocabulary, one sentence per
// reason (DECISIONS.md D45).
//
// The backlog already computed half of this and threw it away: `blocked()`
// returns "waiting on t-0006 (missing)" and only `task:ready` could see it,
// which nothing in the UI called. The other half was never computed at all — a
// task blocked by an unrunnable gate was discovered at `#begin` and parked
// AFTER it had been picked, a missing reviewer meant nothing could land
// project-wide with no sign anywhere, and a dependency CYCLE made both tasks
// score 0 forever while the status line said "nothing ready" without ever
// saying the word cycle.
//
// So: one module, imported by both core/api.js and core/supervisor.js, so the
// sentence on the board and the sentence in the headline cannot disagree.
// Pure — every input is passed in — because the whole point is that it is
// testable, and because the same function has to answer for a task nobody has
// tried yet and for one that has been parked for a week.
import { unrunnableGates } from './gates.js';
import { LEVELS, levelFor } from './levels.js';

// An hour, mirrored from core/backlog.js DEFAULT_LEASE_MS. Not imported: it is
// module-private there, and a lease length is a number that changes about as
// often as the file it lives in. If that one moves, this comment is the reason
// to move this one.
export const LEASE_MS = 60 * 60 * 1000;

// Blockers that belong to the PROJECT rather than to any one task. Computed
// once and attached to the board; repeating "no reviewer" on forty cards is a
// badge storm, not information.
export const PROJECT_KINDS = new Set(['no-reviewer', 'budget-hard', 'budget-soft', 'loop-stopped', 'no-model']);

const blocker = (kind, severity, summary, extra = {}) => ({
  kind,
  severity,
  summary,
  detail: extra.detail ?? null,
  subjects: extra.subjects ?? [],
  remedy: extra.remedy ?? null
});

const remedy = (action, label, args = {}) => ({ action, label, args });

/**
 * Every blocker on one task, most actionable first.
 *
 * `ctx` is everything the answer depends on and nothing else:
 *   tasks    — the whole backlog, for dependencies and cycles
 *   config   — the project config (loop.parallelism, loop.minLevel, gates)
 *   settings — app settings (workers.reviewer, loopModels, providerKeys)
 *   caps     — the spend ceilings
 *   spend    — what `ledger:check` said (its `hits`/`action`)
 *   status   — the supervisor's status(), for running/inFlight
 *   now      — injectable clock, so a lease test is not a sleep
 *   cwd      — where gate commands would run, for the interpreter check
 */
export function blockersFor(task, ctx = {}) {
  const out = [];
  if (!task) return out;
  const { tasks = [], now = Date.now() } = ctx;
  const byId = new Map(tasks.map(t => [t.id, t]));

  // --- Unreadable ---------------------------------------------------------
  // A file in the queue directory that would not parse. It has no status, no
  // dependencies and no way out except removal, so nothing below applies.
  if (task.unreadable || task.error) {
    return [blocker('unreadable', 'blocked',
      'This file in the backlog directory could not be read, so the loop skips it.',
      {
        detail: String(task.error ?? task.unreadable),
        subjects: [task.id],
        remedy: remedy('remove-task', 'Remove it', { id: task.id })
      })];
  }

  // --- Dependencies -------------------------------------------------------
  const deps = Array.isArray(task.dependsOn) ? task.dependsOn.filter(Boolean) : [];
  const missing = deps.filter(id => !byId.has(id));
  if (missing.length) {
    out.push(blocker('dep-missing', 'blocked',
      missing.length === 1
        ? `Waiting for ${missing[0]}, which does not exist.`
        : `Waiting for ${missing.length} tasks that do not exist: ${missing.join(', ')}.`,
      {
        detail: 'It was removed, or the id was written down wrong. This task can never be picked while it names a task that is not there.',
        subjects: missing,
        remedy: remedy('remove-dep', missing.length === 1 ? `Drop the dependency on ${missing[0]}` : 'Drop the missing dependencies',
          { id: task.id, dependsOn: deps.filter(d => !missing.includes(d)) })
      }));
  }

  // A cycle is a real bug being fixed here, not merely reported: today two
  // tasks that depend on each other both score 0 forever, and the loop reports
  // "nothing ready" without ever using the word.
  const cycle = cycleThrough(task.id, tasks);
  if (cycle) {
    out.push(blocker('dep-cycle', 'blocked',
      `Circular dependency: ${cycle.join(' → ')}.`,
      {
        detail: 'Every task in this ring is waiting on another one in it, so none of them can ever be picked. Remove one of the links to break the circle.',
        subjects: cycle.slice(0, -1),
        remedy: remedy('break-cycle', `Stop ${cycle[0]} depending on ${cycle[1]}`,
          { id: cycle[0], drop: cycle[1] })
      }));
  }

  const present = deps.map(id => byId.get(id)).filter(Boolean);
  const dead = present.filter(d => d.status === 'failed' || d.status === 'parked');
  if (dead.length) {
    out.push(blocker('dep-failed', 'blocked',
      dead.length === 1
        ? `Waiting for ${dead[0].id}, which is ${dead[0].status} — it will not finish on its own.`
        : `Waiting for ${dead.length} tasks that are failed or parked: ${dead.map(d => d.id).join(', ')}.`,
      {
        detail: dead[0].blockedReason ? `${dead[0].id}: ${dead[0].blockedReason}` : null,
        subjects: dead.map(d => d.id),
        remedy: remedy('open-task', `Open ${dead[0].id}`, { id: dead[0].id })
      }));
  }

  const unlanded = present.filter(d => d.status !== 'landed' && !dead.includes(d));
  if (unlanded.length) {
    out.push(blocker('dep-unlanded', 'blocked',
      unlanded.length === 1
        ? `Waiting for ${unlanded[0].id} (${unlanded[0].status}) to finish.`
        : `Waiting for ${unlanded.length} tasks to finish: ${unlanded.map(d => `${d.id} (${d.status})`).join(', ')}.`,
      {
        // One level deep, deliberately. Two levels is a graph nobody reads in
        // a card; the chain view is where that belongs.
        detail: chainNote(unlanded[0], byId),
        subjects: unlanded.map(d => d.id),
        remedy: null
      }));
  }

  // --- Gates --------------------------------------------------------------
  // The task declares a check this machine cannot run, which makes it
  // unlandable however good the work is. Today that is discovered at #begin,
  // after it has been picked.
  const badGates = unrunnableGates(task.gates ?? [], ctx.cwd ? { cwd: ctx.cwd } : {});
  if (badGates.length) {
    out.push(blocker('gate-unrunnable', 'blocked',
      badGates.length === 1
        ? `Cannot run its check \`${badGates[0].command}\`: ${badGates[0].problem}.`
        : `${badGates.length} checks cannot run on this machine.`,
      {
        detail: badGates.map(g => `\`${g.command}\` — ${g.problem}`).join('; '),
        subjects: badGates.map(g => g.command),
        remedy: remedy('edit-gates', 'Fix its gates', { id: task.id, gates: task.gates ?? [] })
      }));
  }

  // --- Lease --------------------------------------------------------------
  if ((task.status === 'claimed' || task.status === 'running') && task.claimedAt) {
    const held = now - Date.parse(task.claimedAt);
    if (Number.isFinite(held) && held > (ctx.leaseMs ?? LEASE_MS)) {
      out.push(blocker('lease-held', 'blocked',
        `Stuck with ${task.claimedBy ?? 'a worker'} since ${task.claimedAt.slice(0, 16).replace('T', ' ')}, over an hour ago — the lease has expired.`,
        {
          detail: 'The worker that claimed it probably exited without releasing it. Releasing it puts it back in the queue.',
          subjects: [task.claimedBy].filter(Boolean),
          remedy: remedy('release-task', 'Release it', { id: task.id })
        }));
    }
  }

  // --- Out of ladder ------------------------------------------------------
  if (task.status === 'parked') {
    const top = (task.level ?? null) === LEVELS[LEVELS.length - 1];
    out.push(blocker('attempts-exhausted', 'blocked',
      top
        ? `Tried ${task.attempts ?? 0} times and still needs help — already at the strongest model, so it will not retry on its own.`
        : `Tried ${task.attempts ? `${task.attempts} time(s)` : 'once'} and now needs your help to try again.`,
      {
        detail: task.blockedReason ?? null,
        subjects: [task.id],
        remedy: top
          ? remedy('requeue', 'Put it back in the queue', { id: task.id })
          : remedy('requeue-up', 'Try again with a stronger model', { id: task.id })
      }));
  }

  // --- Capacity (a warning, not a wall) -----------------------------------
  const parallelism = ctx.config?.loop?.parallelism ?? 1;
  const inFlight = ctx.status?.inFlight?.length ?? 0;
  if (task.status === 'queued' && !out.length && ctx.status?.running && inFlight >= parallelism) {
    out.push(blocker('parallelism-full', 'warning',
      `Ready to run — waiting for a free worker (${inFlight} of ${parallelism} busy).`,
      {
        detail: 'It will be picked as soon as something in flight finishes.',
        subjects: [],
        remedy: remedy('raise-parallelism', 'Run more at once', { parallelism: parallelism + 1 })
      }));
  }

  // Actionable first: a blocker with a button beats one that only explains,
  // because the reader's next move is the button. Within that, blocked before
  // warning — a warning must never be the first thing a stuck task says.
  return out.sort(rank);
}

const SEVERITY_ORDER = { blocked: 0, warning: 1 };
function rank(a, b) {
  const bySeverity = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
  if (bySeverity) return bySeverity;
  return (a.remedy ? 0 : 1) - (b.remedy ? 0 : 1);
}

/**
 * Blockers that stop the whole project, not one task.
 *
 * A banner, not a badge on forty cards. Each one is a single sentence that is
 * true of the board as a whole and false of any individual task on it.
 */
export function boardBlockers(ctx = {}) {
  const { settings = {}, spend = null, status = {}, tasks = [], config = {} } = ctx;
  const out = [];

  // Nothing can LAND without a reviewer — the loop will run, verify, and stop
  // before merging. That is the most expensive silent failure on this page:
  // a whole night of work that cannot be accepted.
  const reviewer = settings.workers?.reviewer;
  if (!reviewer?.model) {
    out.push(blocker('no-reviewer', 'blocked',
      'No reviewer model is set, so completed work cannot be approved.',
      {
        detail: 'The loop will pick tasks, run them and verify them, then stop before merging. Choose a reviewer to let work be approved.',
        subjects: [],
        remedy: remedy('set-reviewer', 'Choose a reviewer', {})
      }));
  }

  // The ladder has nothing on it and there is no key to ask a router with, so
  // a picked task has no model to run on.
  const anyBand = LEVELS.some(b => settings.loopModels?.[b]);
  // Two shapes, because two callers. `publicSettings()` never lets a key out of
  // the main process and reports `providers.<id>.hasKey` instead; the CLI and
  // the runtime config carry `providerKeys`. Reading only one of them would
  // make this banner wrong in exactly one of the two places it appears.
  const hasRouterKey = Boolean(
    settings.providerKeys?.openrouter
    || settings.providers?.openrouter?.hasKey
    || settings.workers?.loop?.model
  );
  if (!anyBand && !hasRouterKey) {
    out.push(blocker('no-model', 'blocked',
      'No model is configured for any effort band, and there is no OpenRouter key to route with.',
      {
        detail: 'Pick a model for at least one band, or add an OpenRouter key so the router can choose one.',
        subjects: [],
        remedy: remedy('set-model', 'Choose a model', {})
      }));
  }

  if (spend?.hits?.includes('hard')) {
    out.push(blocker('budget-hard', 'blocked',
      `Spending limit of $${Number(spend.caps?.hardUsd ?? 0).toFixed(2)} reached — the loop has paused.`,
      {
        detail: `$${Number(spend.window?.usd ?? 0).toFixed(2)} spent in the current window.`,
        subjects: [],
        remedy: remedy('raise-cap', 'Raise the cap', { which: 'hardUsd', current: spend.caps?.hardUsd ?? null })
      }));
  } else if (spend?.hits?.includes('soft')) {
    out.push(blocker('budget-soft', 'warning',
      `Soft spending limit of $${Number(spend.caps?.softUsd ?? 0).toFixed(2)} reached — work continues but will not use a more expensive model.`,
      {
        detail: `$${Number(spend.window?.usd ?? 0).toFixed(2)} spent in the current window.`,
        subjects: [],
        remedy: remedy('raise-cap', 'Raise the soft cap', { which: 'softUsd', current: spend.caps?.softUsd ?? null })
      }));
  }

  // Something is ready and nothing is going to pick it up. Only worth saying
  // when there IS something ready: "the loop is stopped" over an empty queue is
  // the normal, finished state.
  if (!status.running) {
    const ready = tasks.some(t => t.status === 'queued' && !blockersFor(t, { ...ctx, status: {} }).some(b => b.severity === 'blocked'));
    if (ready) {
      out.push(blocker('loop-stopped', 'blocked',
        'There is work ready and no loop running to pick it up.',
        {
          detail: null,
          subjects: [],
          remedy: remedy('start-loop', 'Start the loop', {})
        }));
    }
  }

  void config;
  return out.sort(rank);
}

/** Blockers for every task, keyed by id. One pass over a list already in memory. */
export function blockersAll(ctx = {}) {
  const map = new Map();
  for (const task of ctx.tasks ?? []) map.set(task.id, blockersFor(task, ctx));
  for (const problem of ctx.problems ?? []) map.set(problem.id, blockersFor({ ...problem, unreadable: true }, ctx));
  return map;
}

/**
 * The headline sentence: why nothing is being picked up.
 *
 * The supervisor's `#whyNothingReady()` and the board read the same function,
 * so the line at breakfast and the line on the card use the same words.
 */
export function whyNothingReady(ctx = {}) {
  const tasks = ctx.tasks ?? [];
  const queued = tasks.filter(t => t.status === 'queued');
  if (!queued.length) {
    const open = tasks.filter(t => !['landed', 'failed'].includes(t.status));
    if (!open.length) return 'backlog empty';
    // Not empty — everything left is parked or in flight, which is a different
    // fact and the one D44 recorded being reported wrongly.
    const parked = open.filter(t => t.status === 'parked').length;
    return parked
      ? `nothing queued — ${parked} task(s) waiting on you`
      : `nothing queued — ${open.length} task(s) still in flight`;
  }
  const blocked = queued
    .map(t => ({ task: t, blockers: blockersFor(t, ctx).filter(b => b.severity === 'blocked') }))
    .filter(e => e.blockers.length);
  if (!blocked.length) return 'nothing ready';
  const shown = blocked.slice(0, 3).map(e => `${e.task.id} (${e.blockers[0].summary})`).join(', ');
  const rest = blocked.length > 3 ? `, and ${blocked.length - 3} more` : '';
  return `nothing ready — ${blocked.length} task(s) blocked: ${shown}${rest}`;
}

// --- helpers ---------------------------------------------------------------

/**
 * The cycle `id` sits in, as a closed ring `[a, b, …, a]`, or null.
 *
 * Colour DFS rather than Tarjan: this is thirty lines instead of eighty and the
 * question asked is narrower than "find all SCCs" — a card only needs the ring
 * it is standing in, and it needs the ring in ORDER so the error can name an
 * edge to cut.
 */
export function cycleThrough(id, tasks = []) {
  const edges = new Map(tasks.map(t => [t.id, (t.dependsOn ?? []).filter(d => d)]));
  if (!edges.has(id)) return null;
  const state = new Map(); // id -> 'open' | 'done'
  const stack = [];

  const walk = node => {
    if (state.get(node) === 'done') return null;
    if (state.get(node) === 'open') {
      // Found a back edge: the ring is the stack from that node onward.
      const at = stack.indexOf(node);
      return at === -1 ? null : [...stack.slice(at), node];
    }
    if (!edges.has(node)) return null; // a missing dep is dep-missing, not a cycle
    state.set(node, 'open');
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const found = walk(next);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 'done');
    return null;
  };

  const ring = walk(id);
  // Only report the ring on the tasks that are actually IN it. Walking from a
  // task that merely points AT a cycle would otherwise blame the bystander.
  return ring && ring.includes(id) ? ring : null;
}

// "which is itself waiting on t-0004" — one level, no further.
function chainNote(dep, byId) {
  const next = (dep.dependsOn ?? []).map(id => byId.get(id)).filter(d => d && d.status !== 'landed');
  if (!next.length) return null;
  return `${dep.id} is itself waiting on ${next.map(d => d.id).join(', ')}.`;
}

// Re-exported so a caller that wants the band a task would run at does not have
// to import two modules to ask one question.
export { levelFor };
