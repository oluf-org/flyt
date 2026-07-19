const { contextBridge, ipcRenderer } = require('electron');

// Run-scoped calls take the projectId of the tab they act for (D22 T7); flows,
// templates and settings are global (T2) and stay unscoped.
contextBridge.exposeInMainWorld('llmflow', {
  approvePlan: (pid, runId) => ipcRenderer.invoke('run:approve', pid, runId),
  rejectPlan: (pid, runId, reason) => ipcRenderer.invoke('run:reject', pid, runId, reason),
  resumeRun: (pid, runId) => ipcRenderer.invoke('run:resume', pid, runId),
  followUpRun: (pid, runId, text) => ipcRenderer.invoke('run:followUp', pid, runId, text),
  listRuns: (pid) => ipcRenderer.invoke('run:list', pid),
  renameRun: (pid, runId, name) => ipcRenderer.invoke('run:rename', pid, runId, name),
  deleteRun: (pid, runId) => ipcRenderer.invoke('run:delete', pid, runId),
  getSnapshot: (pid, runId) => ipcRenderer.invoke('run:snapshot', pid, runId),
  readRunLog: (pid, runId) => ipcRenderer.invoke('run:log', pid, runId),
  openRunFolder: (pid, runId) => ipcRenderer.invoke('run:openFolder', pid, runId),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (pid, runId) => ipcRenderer.invoke('workspace:open', pid, runId),
  runFlow: (pid, id, userInput, workspaceDir) => ipcRenderer.invoke('flow:run', pid, id, userInput, workspaceDir),
  getConfig: () => ipcRenderer.invoke('config:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  listFlows: () => ipcRenderer.invoke('flow:list'),
  loadFlow: (id) => ipcRenderer.invoke('flow:load', id),
  saveFlow: (flow) => ipcRenderer.invoke('flow:save', flow),
  newFlow: () => ipcRenderer.invoke('flow:new'),
  deleteFlow: (id) => ipcRenderer.invoke('flow:delete', id),
  lintFlow: (id) => ipcRenderer.invoke('flow:lint', id),
  getFlowYaml: (flow) => ipcRenderer.invoke('flow:toYaml', flow),
  saveFlowFromYaml: (id, yaml) => ipcRenderer.invoke('flow:saveFromYaml', id, yaml),
  lintFlowYaml: (yamlText) => ipcRenderer.invoke('flow:lintYaml', yamlText),
  loadFlowSource: (id) => ipcRenderer.invoke('flow:loadSource', id),
  listNodeTemplates: () => ipcRenderer.invoke('node:list'),
  saveNodeTemplate: (tpl) => ipcRenderer.invoke('node:save', tpl),
  newNodeTemplate: () => ipcRenderer.invoke('node:new'),
  deleteNodeTemplate: (id) => ipcRenderer.invoke('node:delete', id),
  setTitleBarTheme: (mode) => ipcRenderer.invoke('titlebar:setTheme', mode),

  // --- Project tabs (D22) ---
  listProjects: () => ipcRenderer.invoke('project:list'),
  openProject: (folder) => ipcRenderer.invoke('project:open', folder),
  closeProject: (pid) => ipcRenderer.invoke('project:close', pid),
  activateProject: (pid) => ipcRenderer.invoke('project:activate', pid),
  reorderProjects: (ids) => ipcRenderer.invoke('project:reorder', ids),
  saveProjectState: (pid, state) => ipcRenderer.invoke('project:saveState', pid, state),
  projectRecents: () => ipcRenderer.invoke('project:recents'),
  removeProjectRecent: (folder) => ipcRenderer.invoke('project:removeRecent', folder),
  pickProjectFolder: () => ipcRenderer.invoke('project:pickFolder'),
  deckData: () => ipcRenderer.invoke('project:deckData'),

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
});
