const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('llmflow', {
  approvePlan: (runId) => ipcRenderer.invoke('run:approve', runId),
  rejectPlan: (runId, reason) => ipcRenderer.invoke('run:reject', runId, reason),
  resumeRun: (runId) => ipcRenderer.invoke('run:resume', runId),
  followUpRun: (runId, text) => ipcRenderer.invoke('run:followUp', runId, text),
  listRuns: () => ipcRenderer.invoke('run:list'),
  renameRun: (runId, name) => ipcRenderer.invoke('run:rename', runId, name),
  deleteRun: (runId) => ipcRenderer.invoke('run:delete', runId),
  getSnapshot: (runId) => ipcRenderer.invoke('run:snapshot', runId),
  readRunLog: (runId) => ipcRenderer.invoke('run:log', runId),
  openRunFolder: (runId) => ipcRenderer.invoke('run:openFolder', runId),
  pickWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  openWorkspace: (runId) => ipcRenderer.invoke('workspace:open', runId),
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
  runFlow: (id, userInput, workspaceDir) => ipcRenderer.invoke('flow:run', id, userInput, workspaceDir),
  listNodeTemplates: () => ipcRenderer.invoke('node:list'),
  saveNodeTemplate: (tpl) => ipcRenderer.invoke('node:save', tpl),
  newNodeTemplate: () => ipcRenderer.invoke('node:new'),
  deleteNodeTemplate: (id) => ipcRenderer.invoke('node:delete', id),
  setTitleBarTheme: (mode) => ipcRenderer.invoke('titlebar:setTheme', mode),
  onRunUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('run:update', handler);
    return () => ipcRenderer.removeListener('run:update', handler);
  }
});
