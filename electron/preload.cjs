const { contextBridge, ipcRenderer } = require('electron');

// Run-scoped calls take the projectId of the tab they act for (D22 T7); flows,
// templates and settings are global (T2) and stay unscoped.
const api = {
  v2Build: () => ipcRenderer.invoke('v2:build'),
  v2OpenStack: (id, caller = 'human') => ipcRenderer.invoke('v2:open-stack', id, caller),
  v2ValidateStackSource: (source) => ipcRenderer.invoke('v2:validate-source', source),
  v2SaveStackSource: (source, caller = 'human') => ipcRenderer.invoke('v2:save-source', source, caller),
  v2StackHistory: (nodeId = null, limit = 200) => ipcRenderer.invoke('v2:history', nodeId, limit),
  v2InvokeCommand: (name, args, caller = 'human') =>
    ipcRenderer.invoke('v2:command', name, args, caller),
  onV2Command: (cb) => {
    const handler = (_e, record) => cb(record);
    ipcRenderer.on('v2:command-invoke', handler);
    return () => ipcRenderer.removeListener('v2:command-invoke', handler);
  },
  onV2UiExtensionsChange: (cb) => {
    const handler = (_e, rows) => cb(rows);
    ipcRenderer.on('v2:ui-extensions-change', handler);
    return () => ipcRenderer.removeListener('v2:ui-extensions-change', handler);
  },
  approvePlan: (pid, runId) => ipcRenderer.invoke('run:approve', pid, runId),
  rejectPlan: (pid, runId, reason) => ipcRenderer.invoke('run:reject', pid, runId, reason),
  resumeRun: (pid, runId) => ipcRenderer.invoke('run:resume', pid, runId),
  // --- Run control (RUN-CONTROL): stop / pause / restart / branch / investigate.
  // resumeRun doubles as the pause-release; restartNode/branchRun reject while live.
  stopRun: (pid, runId) => ipcRenderer.invoke('run:stop', pid, runId),
  pauseRun: (pid, runId) => ipcRenderer.invoke('run:pause', pid, runId),
  // `worker` ({ provider, model }) re-pins the node's model for the retry (D39);
  // omit it to re-run exactly as configured.
  restartNode: (pid, runId, nodeId, guidance, worker = null) =>
    ipcRenderer.invoke('run:restartNode', pid, runId, nodeId, guidance, worker),
  branchRun: (pid, runId, nodeId) => ipcRenderer.invoke('run:branch', pid, runId, nodeId),
  investigateNode: (pid, runId, nodeId) =>
    ipcRenderer.invoke('run:investigateNode', pid, runId, nodeId),
  // Summary nodes (B4): summarize sources / delete / persist a dragged position.
  summarizeRun: (pid, runId, sourceIds, position = null) =>
    ipcRenderer.invoke('run:summarize', pid, runId, sourceIds, position),
  deleteSummary: (pid, runId, summaryId) =>
    ipcRenderer.invoke('run:deleteSummary', pid, runId, summaryId),
  moveSummary: (pid, runId, summaryId, position) =>
    ipcRenderer.invoke('run:moveSummary', pid, runId, summaryId, position),
  followUpRun: (pid, runId, text) => ipcRenderer.invoke('run:followUp', pid, runId, text),
  // Answer a run parked at the refiner's awaiting_input gate (DECISIONS.md D27).
  answerInput: (pid, runId, text) => ipcRenderer.invoke('run:answerInput', pid, runId, text),
  // Approval gates: the chat run tells the main process when a run parks at a
  // gate (and when it settles), so an unfocused window can raise an OS
  // notification + taskbar flash — a stopped workflow must find the user.
  signalApprovalGate: (info) => ipcRenderer.invoke('app:approvalGate', info),
  listRuns: (pid) => ipcRenderer.invoke('run:list', pid),
  // Comparison records (DECISIONS.md D27): begin mints the shared group id
  // before the two runs start; save persists { id, runIds, origin } and stamps
  // both runs' metas; list feeds the ⚖ badge + pairing restore.
  beginCompare: (pid) => ipcRenderer.invoke('compare:begin', pid),
  saveCompare: (pid, rec) => ipcRenderer.invoke('compare:save', pid, rec),
  listComparisons: (pid) => ipcRenderer.invoke('compare:list', pid),
  judgeRuns: (pid, a, b, cmpId = null) => ipcRenderer.invoke('run:judge', pid, a, b, cmpId),
  renameRun: (pid, runId, name) => ipcRenderer.invoke('run:rename', pid, runId, name),
  deleteRun: (pid, runId) => ipcRenderer.invoke('run:delete', pid, runId),
  getSnapshot: (pid, runId) => ipcRenderer.invoke('run:snapshot', pid, runId),
  readRunLog: (pid, runId) => ipcRenderer.invoke('run:log', pid, runId),
  openRunFolder: (pid, runId) => ipcRenderer.invoke('run:openFolder', pid, runId),
  openRunArtifact: (pid, runId, relPath) => ipcRenderer.invoke('run:openArtifact', pid, runId, relPath),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (pid, runId) => ipcRenderer.invoke('workspace:open', pid, runId),
  runFlow: (pid, id, userInput, workspaceDir, approvalMode, launch = null) =>
    ipcRenderer.invoke('flow:run', pid, id, userInput, workspaceDir, approvalMode, launch),
  listWorkflows: () => ipcRenderer.invoke('workflow:list'),
  runWorkflow: (pid, workflowId, input, approvalMode = null, presetId = null) =>
    ipcRenderer.invoke('workflow:run', pid, workflowId, input, approvalMode, presetId),
  getPendingWorkflowInteractions: (pid, runId) => ipcRenderer.invoke('workflow:pending', pid, runId),
  replyWorkflow: (pid, runId, text, approvalMode = null) =>
    ipcRenderer.invoke('workflow:reply', pid, runId, text, approvalMode),
  decideWorkflowCall: (pid, runId, callId, approved) =>
    ipcRenderer.invoke('workflow:decide', pid, runId, callId, approved),
  answerWorkflowQuestion: (pid, runId, questionId, answer) =>
    ipcRenderer.invoke('workflow:answer', pid, runId, questionId, answer),
  onWorkflowEvent: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('workflow:event', handler);
    return () => ipcRenderer.removeListener('workflow:event', handler);
  },
  getConfig: () => ipcRenderer.invoke('config:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: (provider) => ipcRenderer.invoke('models:list', provider),
  modelRankings: (force = false) => ipcRenderer.invoke('models:rankings', force),
  testProvider: (provider) => ipcRenderer.invoke('provider:test', provider),
  listFlows: () => ipcRenderer.invoke('flow:list'),
  loadFlow: (id) => ipcRenderer.invoke('flow:load', id),
  saveFlow: (flow) => ipcRenderer.invoke('flow:save', flow),
  newFlow: () => ipcRenderer.invoke('flow:new'),
  deleteFlow: (id) => ipcRenderer.invoke('flow:delete', id),
  flowFolder: () => ipcRenderer.invoke('flow:folder'),
  openFlowFolder: () => ipcRenderer.invoke('flow:openFolder'),
  lintFlow: (id) => ipcRenderer.invoke('flow:lint', id),
  // Configs (DECISIONS.md D27): create/update, duplicate, and promote a
  // finished run's launch config — all modes on a flow, stored in its YAML.
  saveConfig: (flowId, modeId, config) => ipcRenderer.invoke('flow:saveConfig', flowId, modeId, config),
  duplicateConfig: (flowId, sourceId, newId, name) => ipcRenderer.invoke('flow:duplicateConfig', flowId, sourceId, newId, name),
  promoteRunConfig: (pid, runId, name) => ipcRenderer.invoke('flow:promoteRunConfig', pid, runId, name),
  listConfigs: () => ipcRenderer.invoke('flow:listConfigs'),
  flowLaunchInputs: (id) => ipcRenderer.invoke('flow:launchInputs', id),
  getFlowYaml: (flow) => ipcRenderer.invoke('flow:toYaml', flow),
  saveFlowFromYaml: (id, yaml) => ipcRenderer.invoke('flow:saveFromYaml', id, yaml),
  lintFlowYaml: (yamlText) => ipcRenderer.invoke('flow:lintYaml', yamlText),
  loadFlowSource: (id) => ipcRenderer.invoke('flow:loadSource', id),
  listNodeTemplates: () => ipcRenderer.invoke('node:list'),
  saveNodeTemplate: (tpl) => ipcRenderer.invoke('node:save', tpl),
  newNodeTemplate: () => ipcRenderer.invoke('node:new'),
  deleteNodeTemplate: (id) => ipcRenderer.invoke('node:delete', id),
  setTitleBarTheme: (mode) => ipcRenderer.invoke('titlebar:setTheme', mode),
  listTools: () => ipcRenderer.invoke('tool:list'),

  // --- The reference library (D36 P1) ---
  // Read-only, pinned, shallow clones of any repository you want the app to be
  // able to read. `cloneRepo` is the other mode: a full working clone opened as
  // a project, for when you mean to change it rather than learn from it.
  listReferences: () => ipcRenderer.invoke('ref:list'),
  addReference: (opts) => ipcRenderer.invoke('ref:add', opts),
  removeReference: (name) => ipcRenderer.invoke('ref:remove', name),
  updateReference: (name = null) => ipcRenderer.invoke('ref:update', name),
  searchReferences: (opts) => ipcRenderer.invoke('ref:search', opts),
  readReference: (ref) => ipcRenderer.invoke('ref:read', ref),
  cloneRepo: (opts) => ipcRenderer.invoke('repo:clone', opts),
  toolsFolder: () => ipcRenderer.invoke('tool:folder'),

  // --- Project tabs (D22) ---
  listProjects: () => ipcRenderer.invoke('project:list'),
  openProject: (folder) => ipcRenderer.invoke('project:open', folder),
  createProject: (promptOrName) => ipcRenderer.invoke('project:create', promptOrName),
  renameProject: (pid, name) => ipcRenderer.invoke('project:rename', pid, name),
  adoptProject: (pid, folder) => ipcRenderer.invoke('project:adopt', pid, folder),
  revealProject: (pid) => ipcRenderer.invoke('project:reveal', pid),
  closeProject: (pid) => ipcRenderer.invoke('project:close', pid),
  activateProject: (pid) => ipcRenderer.invoke('project:activate', pid),
  reorderProjects: (ids) => ipcRenderer.invoke('project:reorder', ids),
  saveProjectState: (pid, state) => ipcRenderer.invoke('project:saveState', pid, state),
  projectRecents: () => ipcRenderer.invoke('project:recents'),
  removeProjectRecent: (folder) => ipcRenderer.invoke('project:removeRecent', folder),
  pickProjectFolder: () => ipcRenderer.invoke('project:pickFolder'),
  deckData: () => ipcRenderer.invoke('project:deckData'),

  // --- The loop (DESIGN-SPEC.md §8) ---
  loopStart: (pid, opts = {}) => ipcRenderer.invoke('loop:start', pid, opts),
  loopStop: (pid) => ipcRenderer.invoke('loop:stop', pid),
  loopStatus: (pid) => ipcRenderer.invoke('loop:status', pid),
  loopReport: (pid) => ipcRenderer.invoke('loop:report', pid),
  loopLog: (pid) => ipcRenderer.invoke('loop:log', pid),
  ledgerTotals: (pid, opts = {}) => ipcRenderer.invoke('ledger:totals', pid, opts),
  ledgerCheck: (pid, taskId = null) => ipcRenderer.invoke('ledger:check', pid, taskId),
  listTasks: (pid, status = null) => ipcRenderer.invoke('task:list', pid, status),
  addTask: (pid, task) => ipcRenderer.invoke('task:add', pid, task),
  escalateTask: (pid, id, reason) => ipcRenderer.invoke('task:escalate', pid, id, reason),
  releaseTask: (pid, id, status) => ipcRenderer.invoke('task:release', pid, id, status),
  // Out of the queue for good. `force` is the second press: a claimed task is
  // refused first, because something holds a lease and probably a worktree.
  removeTask: (pid, id, force = false) => ipcRenderer.invoke('task:remove', pid, id, force),
  // The rest of the backlog vocabulary (DECISIONS.md D45). Every one of these was
  // implemented in core/api.js and unreachable from the renderer, which is how
  // the one screen whose job is "what is stuck" ended up unable to say.
  getTask: (pid, id) => ipcRenderer.invoke('task:get', pid, id),
  // Correcting a task's own description of itself - its level, its gates, what
  // it depends on. The BACKLOG decides what may be written; this is a pipe.
  updateTask: (pid, id, patch = {}) => ipcRenderer.invoke('task:update', pid, id, patch),
  taskReady: (pid) => ipcRenderer.invoke('task:ready', pid),
  taskStats: (pid) => ipcRenderer.invoke('task:stats', pid),
  // A worker's worktree: what it has changed, and whether the gates pass.
  // `workDiff` shells out to git, so it belongs on a slow timer and only while
  // something is actually looking at it.
  workDiff: (pid, taskId, base = null) => ipcRenderer.invoke('work:diff', pid, taskId, base),
  workVerify: (pid, taskId) => ipcRenderer.invoke('work:verify', pid, taskId),
  // Which runs are live right now, per project - how a card knows whether the
  // snapshot it is holding is still moving.
  runLive: (pid = null) => ipcRenderer.invoke('run:live', pid),
  // --- The chat (DECISIONS.md D45) ---
  // One turn loop over a read-mostly toolset whose single write is
  // enqueue_task. Not a second orchestrator: work still goes through the loop.
  chatThreads: (pid) => ipcRenderer.invoke('chat:threads', pid),
  chatRead: (pid, threadId) => ipcRenderer.invoke('chat:read', pid, threadId),
  chatNew: (pid) => ipcRenderer.invoke('chat:new', pid),
  chatSend: (pid, threadId, text, worker = null) => ipcRenderer.invoke('chat:send', pid, threadId, text, worker),
  chatStop: (pid, threadId) => ipcRenderer.invoke('chat:stop', pid, threadId),
  chatDelete: (pid, threadId) => ipcRenderer.invoke('chat:delete', pid, threadId),
  chatTools: () => ipcRenderer.invoke('chat:tools'),
  // Streaming tokens and tool calls, mirroring onLoopEvent.
  onChatEvent: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('chat:event', handler);
    return () => ipcRenderer.removeListener('chat:event', handler);
  },

  feedbackStats: (pid) => ipcRenderer.invoke('feedback:stats', pid),
  feedbackDigest: (pid, enqueue = false) => ipcRenderer.invoke('feedback:digest', pid, enqueue),
  archiveTrend: (pid, limit = 30) => ipcRenderer.invoke('archive:trend', pid, limit),
  // One line per supervisor decision, live. Returns an unsubscribe like the
  // other listeners here.
  onLoopEvent: (cb) => {
    const handler = (_e, entry) => cb(entry);
    ipcRenderer.on('loop:event', handler);
    return () => ipcRenderer.removeListener('loop:event', handler);
  },

  onRunUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('run:update', handler);
    return () => ipcRenderer.removeListener('run:update', handler);
  },
  // Live-run set changes per project, for every tab's micro-indicator.
  onProjectActivity: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('project:activity', handler);
    return () => ipcRenderer.removeListener('project:activity', handler);
  },
  // Ctrl+Tab stream from before-input-event: {kind:'cycle',shift} presses and
  // the {kind:'release'} that commits a deck selection (T14, 4.2).
  onTabsKey: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('tabs:key', handler);
    return () => ipcRenderer.removeListener('tabs:key', handler);
  }
};

// D29: renamed from the old brand. The temporary aliasing proxy that guarded
// the codemod is gone — the app was exercised against `window.flyt` alone
// (every panel, and the flow/template/settings/project IPC round trips), and
// tests/brand.test.js now forbids the old name from reappearing.
contextBridge.exposeInMainWorld('flyt', api);
