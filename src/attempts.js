// Attempt history and supersession (WR-05).
//
// The production failure: the default planning attempt died with `spawn EPERM`;
// the user retried through OpenRouter and that attempt ran fine — but the old
// terminal error stayed on screen, competing with the live attempt for the same
// piece of UI. A run had two "current" states and showed the wrong one.
//
// The cause is that a node had exactly one visible outcome, so a retry
// overwrote or collided with its predecessor instead of replacing it. Modelling
// attempts explicitly fixes both halves at once: the node's primary state is
// the newest non-superseded attempt, and the older ones remain inspectable as
// history rather than fighting for the foreground.
//
// Pure, renderer-safe (no node builtins): the engine records attempts, the
// renderer projects them.

export const ATTEMPT_STATUSES = ['active', 'succeeded', 'failed', 'cancelled', 'superseded'];

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

export function newAttemptRef(nodeId, seq) {
  return `${nodeId}#${seq}`;
}

/**
 * Append an attempt for a node, superseding whatever it replaces.
 *
 * Returns a NEW map — the caller writes it back to meta, so this stays pure and
 * testable without a store.
 */
export function recordAttempt(attempts, nodeId, entry = {}) {
  const all = { ...(attempts ?? {}) };
  const list = [...(all[nodeId] ?? [])];
  const seq = list.length + 1;
  const id = entry.attemptId ?? newAttemptRef(nodeId, seq);
  // Anything still open is replaced by this one. A retry does not erase the
  // failure it replaces; it demotes it out of the foreground.
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === 'active' || !list[i].supersededBy) {
      if (list[i].status === 'active') list[i] = { ...list[i], status: 'superseded', supersededBy: id };
      else list[i] = { ...list[i], supersededBy: id };
    }
  }
  list.push({
    attemptId: id, seq,
    status: entry.status ?? 'active',
    at: entry.at ?? new Date().toISOString(),
    ...(entry.worker ? { worker: entry.worker } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.code ? { code: entry.code } : {})
  });
  all[nodeId] = list;
  return all;
}

/** Close the newest open attempt for a node with a terminal status. */
export function settleAttempt(attempts, nodeId, { status = 'failed', error = null, code = null, worker = null } = {}) {
  const all = { ...(attempts ?? {}) };
  const list = [...(all[nodeId] ?? [])];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].status !== 'active') continue;
    list[i] = {
      ...list[i], status,
      ...(error ? { error } : {}),
      ...(code ? { code } : {}),
      ...(worker ? { worker } : {})
    };
    all[nodeId] = list;
    return all;
  }
  return all;
}

/**
 * The attempt a node's visible state comes from: the newest one that has not
 * been superseded. This is the rule that keeps a stale fatal error from
 * competing with a live retry.
 */
export function currentAttempt(attempts, nodeId) {
  const list = attempts?.[nodeId] ?? [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].status !== 'superseded' && !list[i].supersededBy) return list[i];
  }
  return list[list.length - 1] ?? null;
}

/** Everything that came before the current attempt, newest first. */
export function priorAttempts(attempts, nodeId) {
  const current = currentAttempt(attempts, nodeId);
  return (attempts?.[nodeId] ?? [])
    .filter(a => a.attemptId !== current?.attemptId)
    .slice()
    .reverse();
}

/**
 * Should this node's failure be shown as the run's failure?
 *
 * No, when a newer attempt has replaced it — which is precisely the state the
 * old UI got wrong.
 */
export function isSuperseded(attempts, nodeId, attemptId) {
  const list = attempts?.[nodeId] ?? [];
  const found = list.find(a => a.attemptId === attemptId);
  return Boolean(found && (found.status === 'superseded' || found.supersededBy));
}

/** A compact, bounded summary for a UI badge: "attempt 2 of 3". */
export function attemptSummary(attempts, nodeId) {
  const list = attempts?.[nodeId] ?? [];
  if (list.length < 2) return null;
  const current = currentAttempt(attempts, nodeId);
  return { seq: current?.seq ?? list.length, total: list.length, hasHistory: true };
}

export const isTerminalAttempt = status => TERMINAL.has(status);
