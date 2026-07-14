const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('llmflow', {
  approvePlan: (runId) => ipcRenderer.invoke('run:approve', runId),
  rejectPlan: (runId, reason) => ipcRenderer.invoke('run:reject', runId, reason),
  listRuns: () => ipcRenderer.invoke('run:list'),
  getSnapshot: (runId) => ipcRenderer.invoke('run:snapshot', runId),
  openRunFolder: (runId) => ipcRenderer.invoke('run:openFolder', runId),
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
  runFlow: (id, userInput) => ipcRenderer.invoke('flow:run', id, userInput),
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
