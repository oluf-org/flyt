import { watchingFromRun } from './dailyWorkModel.js';

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

/** Subscribe only to the addressed run; unrelated project activity is inert. */
export function subscribeDailyRun(flyt, {
  getProjectId, getRunId, onWatching, onError = () => {},
}) {
  return flyt.onRunUpdate?.(payload => {
    if (!payload?.runId || payload.runId !== getRunId()) return;
    readDailyRun(flyt, getProjectId(), payload.runId).then(onWatching, onError);
  });
}

/** Launch the normal prompt path, including the first projectless prompt. */
export async function launchDailyPrompt({
  flyt, projectId, flowId, text, approvalMode = null, modeId = null,
  overrides = {}, inputs = {}, hasDeclaredInputs = false,
}) {
  let projectPayload = null;
  if (!projectId) {
    projectPayload = await flyt.createProject(text);
    projectId = projectPayload.opened;
    await flyt.saveProjectState?.(projectId, { runFlowId: flowId, runModeId: modeId });
  }
  const launch = {
    ...(modeId ? { modeId } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
    ...(hasDeclaredInputs ? { inputs } : {}),
  };
  const runId = await flyt.runFlow(
    projectId, flowId, text, null, approvalMode,
    Object.keys(launch).length ? launch : null,
  );
  const [watching, runs] = await Promise.all([
    readDailyRun(flyt, projectId, runId),
    flyt.listRuns(projectId),
  ]);
  return { projectId, projectPayload, runId, watching, runs: runs ?? [] };
}
