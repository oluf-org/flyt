const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('llmflow', {
  startRun: (prompt) => ipcRenderer.invoke('run:start', prompt),
  approvePlan: (runId) => ipcRenderer.invoke('run:approve', runId),
  rejectPlan: (runId, reason) => ipcRenderer.invoke('run:reject', runId, reason),
  listRuns: () => ipcRenderer.invoke('run:list'),
  getSnapshot: (runId) => ipcRenderer.invoke('run:snapshot', runId),
  openRunFolder: (runId) => ipcRenderer.invoke('run:openFolder', runId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  listModels: () => ipcRenderer.invoke('models:list'),
  setTitleBarTheme: (mode) => ipcRenderer.invoke('titlebar:setTheme', mode),
  onRunUpdate: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('run:update', handler);
    return () => ipcRenderer.removeListener('run:update', handler);
  }
});
