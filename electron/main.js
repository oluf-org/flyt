import { app, BrowserWindow, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../core/state.js';
import { Pipeline } from '../core/pipeline.js';
import { FlowStore } from '../core/flowstore.js';
import { FlowRunner } from '../core/flowRunner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const baseConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));
const store = new RunStore(path.join(projectRoot, 'runs'));
const flows = new FlowStore(path.join(projectRoot, 'flows'));

// --- Settings & secrets ---
// settings.json lives in userData (never the repo). Shape:
//   { openrouterApiKey: string, workers: { planner|router|executor|verifier: { provider, model } } }
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); }
  catch { return {}; }
}
function persistSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();

// Runtime config = config.json defaults merged with settings.json overrides,
// with the OpenRouter key injected into matching workers. Rebuilt in place on
// every settings save so the running Pipeline picks up changes without a
// restart (Pipeline holds a reference to this object).
const runtimeConfig = { ...baseConfig };

function rebuildRuntimeConfig() {
  const workers = {};
  for (const [name, def] of Object.entries(baseConfig.workers)) {
    const override = settings.workers?.[name];
    const w = override?.provider && override?.model
      ? { provider: override.provider, model: override.model }
      : { provider: def.provider, model: def.model };
    if (w.provider === 'openrouter' && settings.openrouterApiKey) w.apiKey = settings.openrouterApiKey;
    workers[name] = w;
  }
  runtimeConfig.workers = workers;
  // Per-provider key lookup for task workers persisted in runs/tasks.json,
  // which must never contain the key itself.
  runtimeConfig.providerKeys = settings.openrouterApiKey ? { openrouter: settings.openrouterApiKey } : {};
}
rebuildRuntimeConfig();

// What the renderer is allowed to see: worker assignments plus whether a key
// exists. The raw key never crosses the IPC boundary.
function publicSettings() {
  return {
    hasKey: Boolean(settings.openrouterApiKey),
    workers: Object.fromEntries(
      Object.entries(runtimeConfig.workers).map(([name, w]) => [name, { provider: w.provider, model: w.model }])
    )
  };
}

const isMac = process.platform === 'darwin';

// Native window chrome, themed to the app's --app title-bar token so the
// custom title bar we render in the renderer flows seamlessly into the OS
// window controls. Colors mirror the light/dark tokens in styles.css.
const CHROME = {
  light: { color: '#1f2724', symbolColor: '#e6ebe8', height: 40 },
  dark:  { color: '#0f1512', symbolColor: '#dfe7e2', height: 40 }
};

let win = null;
const pushUpdate = runId => {
  // Push every state change to the renderer as a full file-state snapshot.
  if (win && !win.isDestroyed()) {
    win.webContents.send('run:update', { runId, snapshot: store.snapshot(runId) });
  }
};
const pipeline = new Pipeline(store, runtimeConfig, pushUpdate);
const flowRunner = new FlowRunner(store, runtimeConfig, pushUpdate);

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'LLM Flow',
    backgroundColor: CHROME.light.color, // matches the title bar, not the canvas, to avoid a light flash at the top
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? {} : { titleBarOverlay: CHROME.light }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (process.env.VITE_DEV_SERVER) {
    win.loadURL(process.env.VITE_DEV_SERVER);
  } else {
    win.loadFile(path.join(projectRoot, 'dist', 'index.html'));
  }
}

// --- IPC surface (thin: everything else lives in core/) ---
ipcMain.handle('run:start', (_e, prompt) => pipeline.start(prompt));
// Approval routes to whichever engine owns the run (flow runs carry a flowId).
ipcMain.handle('run:approve', (_e, runId) =>
  flowRunner.owns(runId) ? flowRunner.approvePlan(runId) : pipeline.approvePlan(runId));
ipcMain.handle('run:reject', (_e, runId, reason) =>
  flowRunner.owns(runId) ? flowRunner.rejectPlan(runId, reason) : pipeline.rejectPlan(runId, reason));
ipcMain.handle('flow:run', (_e, flowId) => {
  const flow = flows.load(flowId);
  // The built-in flow IS the classic pipeline — run it via run:start so its
  // behavior stays byte-for-byte identical.
  if (flow.builtin) throw new Error('Run the built-in pipeline from the New run box.');
  return flowRunner.start(flow);
});
ipcMain.handle('run:list', () => store.listRuns());
ipcMain.handle('run:snapshot', (_e, runId) => store.snapshot(runId));
ipcMain.handle('run:openFolder', (_e, runId) => shell.openPath(store.runDir(runId)));
ipcMain.handle('config:get', () => ({ workers: publicSettings().workers }));

// --- Flow definitions (editable workflow graphs) ---
ipcMain.handle('flow:list', () => flows.list());
ipcMain.handle('flow:load', (_e, id) => flows.load(id));
ipcMain.handle('flow:save', (_e, flow) => flows.save(flow));
ipcMain.handle('flow:new', () => {
  const { provider, model } = runtimeConfig.workers.executor;
  return flows.create({ provider, model });
});
ipcMain.handle('flow:delete', (_e, id) => flows.remove(id));

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', (_e, patch = {}) => {
  // Only overwrite the stored key when a non-empty string is provided, so the
  // renderer can save worker changes without ever knowing (or clearing) the key.
  if (typeof patch.openrouterApiKey === 'string' && patch.openrouterApiKey.trim()) {
    settings.openrouterApiKey = patch.openrouterApiKey.trim();
  }
  if (patch.workers && typeof patch.workers === 'object') {
    settings.workers = { ...settings.workers };
    for (const [name, w] of Object.entries(patch.workers)) {
      if (baseConfig.workers[name] && w?.provider && w?.model) {
        settings.workers[name] = { provider: w.provider, model: w.model };
      }
    }
  }
  persistSettings();
  rebuildRuntimeConfig();
  return publicSettings();
});

ipcMain.handle('models:list', async () => {
  if (!settings.openrouterApiKey) throw new Error('No OpenRouter API key saved. Add one in Settings first.');
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${settings.openrouterApiKey}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter models ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return (data.data ?? []).map(m => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? null,
    supportsTools: (m.supported_parameters || []).includes('tools')
  }));
});
// Re-tint the native window controls when the renderer flips theme.
ipcMain.handle('titlebar:setTheme', (_e, mode) => {
  if (isMac || !win || win.isDestroyed() || !win.setTitleBarOverlay) return;
  win.setTitleBarOverlay(CHROME[mode] ?? CHROME.light);
});

// The custom title bar replaces the native menu; drop the default one.
Menu.setApplicationMenu(null);

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
