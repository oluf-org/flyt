import { mergeSnapshot } from '../../core/snapshotDiff.js';
import { feed } from '../traceModel.js';
import { stackFromSnapshot, watchingFromRun } from './dailyWorkModel.js';

export const DAILY_PROJECT_ACTIONS = Object.freeze([
  'openProject', 'createProject', 'renameProject', 'adoptProject',
  'revealProject', 'closeProject', 'activateProject', 'reorderProjects',
]);

/**
 * One explicit, testable boundary for the project controls the daily host
 * exposes. Keeping this map outside React means the browser mock and Electron
 * preload can be exercised with the same calls instead of source inspection.
 */
export function dailyProjectBridge(flyt) {
  return Object.fromEntries(DAILY_PROJECT_ACTIONS.map(name => [
    name, (...args) => flyt[name](...args),
  ]));
}

export async function readDailyRun(flyt, projectId, runId) {
  if (!projectId || !runId) return null;
  const [snapshot, log] = await Promise.all([
    flyt.getSnapshot(projectId, runId),
    flyt.readRunLog(projectId, runId).catch(() => []),
  ]);
  return watchingFromRun(runId, snapshot, log);
}
/**
 * Apply one pushed kernel delta without touching disk again. Returns a resync
 * request only when a revision or event sequence proves that a message was
 * missed, or for a legacy run whose trace still comes from run.log.
 */
export function applyDailyRunUpdate(current, payload) {
  if (!current || current.runId !== payload?.runId) return { watching: current, resync: true };

  let snapshot = current.snapshot;
  let changed = false;
  if (payload.full) {
    if (!Number.isFinite(payload.rev) || payload.rev > (snapshot?.rev ?? 0)) {
      snapshot = { ...payload.full, ...(Number.isFinite(payload.rev) ? { rev: payload.rev } : {}) };
      changed = true;
    }
  } else if (payload.patch) {
    const alreadyHeld = Number.isFinite(payload.rev) && payload.rev <= (snapshot?.rev ?? 0);
    // A coalesced IPC frame can arrive after an explicit resync completed. Its
    // revision is already represented and must not trigger another read.
    if (!alreadyHeld) {
      if (!snapshot || payload.base !== snapshot.rev) return { watching: current, resync: true };
      snapshot = { ...mergeSnapshot(snapshot, payload.patch), rev: payload.rev };
      changed = true;
    }
  }

  const incoming = Array.isArray(payload.events)
    ? payload.events.filter(event => Number.isFinite(event?.seq) && event.seq > (current.cursor ?? -1))
    : [];
  if (incoming.length) {
    if (!Number.isFinite(current.cursor)) return { watching: current, resync: true };
    incoming.sort((a, b) => a.seq - b.seq);
    if (incoming.some((event, index) => event.seq !== current.cursor + index + 1)) {
      return { watching: current, resync: true };
    }
    feed(current.trace, incoming);
    changed = true;
  }

  // Legacy daily traces are synthesized from both the snapshot and run.log.
  if (changed && current.cursor === null && (payload.full || payload.patch)) {
    return { watching: current, resync: true };
  }
  if (!changed) return { watching: current, resync: false };
  const cursor = incoming.length ? incoming.at(-1).seq : current.cursor;
  return {
    watching: {
      ...current,
      snapshot,
      stack: snapshot !== current.snapshot ? stackFromSnapshot(snapshot) : current.stack,
      // feed mutates the open tail efficiently; fresh outer arrays make the
      // change visible to React memoization without cloning the full trace.
      trace: incoming.length
        ? { ...current.trace, turns: [...current.trace.turns], others: [...current.trace.others] }
        : current.trace,
      cursor,
    },
    resync: false,
  };
}

/** Subscribe only to the addressed run; unrelated project activity is inert. */
export function subscribeDailyRun(flyt, {
  getProjectId, getRunId, getWatching = () => null, onWatching, onError = () => {},
}) {
  let resyncing = false;
  let resyncAgain = false;
  const resync = async () => {
    if (resyncing) { resyncAgain = true; return; }
    resyncing = true;
    try {
      do {
        resyncAgain = false;
        const next = await readDailyRun(flyt, getProjectId(), getRunId());
        if (next) onWatching(next);
      } while (resyncAgain);
    } catch (error) { onError(error); }
    finally { resyncing = false; }
  };
  return flyt.onRunUpdate?.(payload => {
    const projectId = getProjectId();
    if (!payload?.runId || payload.runId !== getRunId()) return;
    if (payload.projectId && payload.projectId !== projectId) return;
    const current = getWatching();
    const applied = applyDailyRunUpdate(current, payload);
    if (applied.resync) { void resync(); return; }
    if (applied.watching !== current) onWatching(applied.watching);
  });
}
