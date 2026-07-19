import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FlowStore } from '../core/flowstore.js';
import { NodeStore } from '../core/nodestore.js';
import { FlowRunner } from '../core/flowRunner.js';
import { Workspace } from '../core/workspace.js';
import { ProjectRegistry, DEFAULT_PROJECT_ID } from '../core/projects.js';
import { lintFlow, lintText } from '../core/flowlang/lint.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { diffSnapshot } from '../core/snapshotDiff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

// One instance per runs/ directory, claimed before anything reads or writes it.
// runs/ is a shared mutable store and liveness is tracked in process memory
// (FlowRunner.live), so a second instance cannot tell a run this process is
// actively executing from one left behind by a crash: its startup
// reconcileInterrupted would rewind the first instance's in-flight tasks to
// 'pending' underneath it, and offer the user a Resume that re-runs real
// bash/write_file calls against the bound repo from a second process. Bail out
// and surface the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

const baseConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));
// Flows and Node Library templates stay global for v1 (D22 T2) — reusable
// expertise shared across every project tab. Runs are per-project; their
// stores live in the project registry below.
const flows = new FlowStore(path.join(projectRoot, 'flows'));
const nodeLibrary = new NodeStore(path.join(projectRoot, 'nodes')); // seeds itself on first launch
flows.ensureDefaultPipeline(); // the classic pipeline, shipped as an editable workflow

// --- Settings & secrets ---
// settings.json lives in userData (never the repo). Shape:
//   { openrouterApiKey: string,
//     workers: { planner|router|executor|verifier: { provider, model } },
//     projectStorage: 'workspace' | 'appdata',        // T2a — where per-project files live
//     projects: { open, active, recents, tabState } } // D22 — tab session (T17)
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
    // Native tool-calling capability, learned from the last models:list fetch
    // (persisted in settings.json). Unknown models fall back to the text
    // tool protocol, which works everywhere.
    if (w.provider === 'openrouter') w.supportsTools = Boolean(settings.modelCapabilities?.[w.model]);
    workers[name] = w;
  }
  runtimeConfig.workers = workers;
  // Per-provider key lookup for task workers persisted in runs/tasks.json,
  // which must never contain the key itself.
  runtimeConfig.providerKeys = settings.openrouterApiKey ? { openrouter: settings.openrouterApiKey } : {};
  // Per-model tool support for task workers resolved at execution time.
  runtimeConfig.modelCapabilities = settings.modelCapabilities ?? {};
  // Category → worker mapping for advanced planning flows (FLOW_NODES.md)
  runtimeConfig.categoryWorkers = baseConfig.categoryWorkers ?? {};
}
rebuildRuntimeConfig();

// What the renderer is allowed to see: worker assignments plus whether a key
// exists. The raw key never crosses the IPC boundary.
function publicSettings() {
  return {
    hasKey: Boolean(settings.openrouterApiKey),
    workers: Object.fromEntries(
      Object.entries(runtimeConfig.workers).map(([name, w]) => [name, { provider: w.provider, model: w.model }])
    ),
    // T2a: where per-project files are written ('workspace' = in-repo .llmflow/,
    // 'appdata' = under userData). Read at project-open time.
    projectStorage: settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'
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

// --- Projects (D22): one RunStore + FlowRunner per project tab ---
// Push plumbing is per project. Bursts of state changes (parallel waves,
// streaming chunks) coalesce into at most one push per (project, run) per tick
// window: the snapshot is built from file state when the timer fires, so the
// last write always wins.
//
// Incremental IPC (V1 task 5): we keep the last snapshot sent per run plus a
// monotonic rev, and push only the diff. The renderer applies patches on top of
// the full snapshot it fetched via run:snapshot; the rev/base pair lets it
// detect a missed update and resync. Session-scoped, bounded by runs touched.
//
// Scoping (T7/T9): diffed run:update pushes carry their projectId and are sent
// only while that project is the ACTIVE tab — background projects keep
// executing (the engine is main-process) and the renderer resyncs from files on
// activation. A separate featherweight project:activity push (live run ids
// only) always goes out, so every tab's live-run indicator stays honest.
const PUSH_COALESCE_MS = 80;
const pushState = new Map(); // projectId -> { pending, channels, lastActivity, activityTimer }
const pushStateFor = projectId => {
  let s = pushState.get(projectId);
  if (!s) pushState.set(projectId, s = {
    pending: new Map(),   // runId -> timer
    channels: new Map(),  // runId -> { snapshot, rev }
    lastActivity: null,   // last live-set signature broadcast
    activityTimer: null
  });
  return s;
};

// Tell the strip which projects have live runs. The trailing re-check catches
// the final write of a run (whose coalesce timer can fire before the runner
// removes it from `live`), so the indicator can't stick on.
function broadcastActivity(projectId, { recheck = true } = {}) {
  if (!win || win.isDestroyed()) return;
  const s = pushStateFor(projectId);
  const live = [...(registry.get(projectId).runner?.live ?? [])];
  const sig = live.join('\n');
  if (sig !== s.lastActivity) {
    s.lastActivity = sig;
    win.webContents.send('project:activity', { projectId, live });
  }
  if (recheck && live.length && !s.activityTimer) {
    s.activityTimer = setTimeout(() => {
      s.activityTimer = null;
      broadcastActivity(projectId, { recheck: false });
    }, 600);
  }
}

const pushUpdateFor = projectId => runId => {
  const s = pushStateFor(projectId);
  if (s.pending.has(runId)) return;
  s.pending.set(runId, setTimeout(() => {
    s.pending.delete(runId);
    if (!win || win.isDestroyed()) return;
    broadcastActivity(projectId);
    // Background project: skip the snapshot/diff work entirely. Its channel
    // baseline goes stale, but activation refetches via run:snapshot, which
    // re-baselines the channel from the same instant (see run:snapshot).
    if (projectId !== registry.activeId) return;
    const entry = registry.get(projectId);
    const next = entry.store.snapshot(runId);
    const chan = s.channels.get(runId);
    // No baseline yet: send the full snapshot so the renderer has something to
    // patch against.
    if (!chan) {
      const rev = 1;
      s.channels.set(runId, { snapshot: next, rev });
      win.webContents.send('run:update', { projectId, runId, rev, base: null, full: next });
      return;
    }
    const patch = diffSnapshot(chan.snapshot, next);
    if (!patch) return; // nothing actually changed — skip the wake-up
    const rev = chan.rev + 1;
    s.channels.set(runId, { snapshot: next, rev });
    win.webContents.send('run:update', { projectId, runId, rev, base: chan.rev, patch });
  }, PUSH_COALESCE_MS));
};

const registry = new ProjectRegistry({
  defaultRunsDir: path.join(projectRoot, 'runs'),
  appDataDir: app.getPath('userData'),
  // T2a: the storage location is a Settings choice, read at project-open time.
  getStorage: () => (settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'),
  createRunner: (store, projectId) => {
    const runner = new FlowRunner(store, runtimeConfig, pushUpdateFor(projectId), nodeLibrary);
    // Nothing is live when a project first opens in this process, so any run
    // still in a non-terminal stage was cut off by the app dying. Flag those
    // once so the run view can offer Resume (V1 task 7).
    const interrupted = runner.reconcileInterrupted();
    if (interrupted.length) console.log(`[llm-flow] ${projectId}: ${interrupted.length} interrupted run(s) marked resumable`);
    return runner;
  },
  onPersist: () => {
    settings.projects = registry.serialize();
    persistSettings();
  }
});
// Browser-style session restore (T17). Tabs whose folder disappeared are
// dropped (recents entry stays); the renderer surfaces them once via
// project:list.
const { dropped: droppedTabs } = registry.restore(settings.projects ?? {});

function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  const entry = registry.get(registry.activeId);
  // T16: <project> — LLM Flow; the scratch tab is just the app.
  win.setTitle(entry.folder ? `${entry.name} — LLM Flow` : 'LLM Flow');
}

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
  // The window title is the active project's name (T16), not the page's.
  win.on('page-title-updated', e => e.preventDefault());
  updateWindowTitle();
  // Ctrl+Tab / Ctrl+Shift+Tab cycle tabs (T14). Intercepted here so a focused
  // canvas/webview/text field can never eat them; the renderer gets a clean
  // event stream (cycle presses + the Ctrl release that commits a deck pick).
  win.webContents.on('before-input-event', (e, input) => {
    if (input.key === 'Tab' && input.control && input.type === 'keyDown') {
      e.preventDefault();
      win.webContents.send('tabs:key', { kind: 'cycle', shift: Boolean(input.shift) });
    } else if (input.key === 'Control' && input.type === 'keyUp') {
      win.webContents.send('tabs:key', { kind: 'release' });
    }
  });
  if (process.env.VITE_DEV_SERVER) {
    win.loadURL(process.env.VITE_DEV_SERVER);
  } else {
    win.loadFile(path.join(projectRoot, 'dist', 'index.html'));
  }
}

// --- IPC surface (thin: everything else lives in core/) ---
// Every run-scoped call takes the projectId it targets (T7); flows, templates
// and settings stay global (T2). `proj` is the one gate a renderer-supplied id
// passes through.
const proj = projectId => registry.get(projectId);

// One engine, one entry point: pick a workflow, type a request, run it.
// The user input becomes the flow's User Input node content for that run.
ipcMain.handle('flow:run', (_e, projectId, flowId, userInput = '', workspaceDir = null) => {
  const entry = proj(projectId);
  // Bind the target workspace at run time (D15): validate the folder, create
  // its .llmflow/ config dir, and pass the confined absolute root to the runner
  // so it lands in meta.json. A bound tab IS the workspace — its runs always
  // target the tab's folder (T19); only the unbound scratch tab still picks a
  // workspace per run (or none — mock/no-file flows run without one).
  let workspace = null;
  if (entry.folder) workspace = new Workspace(entry.folder).ensure().root;
  else if (workspaceDir) workspace = new Workspace(workspaceDir).ensure().root;
  return entry.runner.start(flows.load(flowId), { userInput: String(userInput ?? ''), workspace });
});
ipcMain.handle('run:approve', (_e, projectId, runId) => proj(projectId).runner.approvePlan(runId));
ipcMain.handle('run:reject', (_e, projectId, runId, reason) => proj(projectId).runner.rejectPlan(runId, reason));
// Continue a run the app died in the middle of. Completed nodes are kept and
// not re-executed (V1 task 7).
ipcMain.handle('run:resume', (_e, projectId, runId) => proj(projectId).runner.resume(runId));
// Reply to a finished run (FOLLOWUP-PLAN): the flow grows with a continuation
// subgraph and the walk executes it; completed nodes are never re-run.
ipcMain.handle('run:followUp', (_e, projectId, runId, text) => proj(projectId).runner.followUp(runId, String(text ?? '')));
// Summaries, not bare ids: the list names, groups and sorts runs, and reading
// meta + prompt per run is a handful of small synchronous reads.
ipcMain.handle('run:list', (_e, projectId) => proj(projectId).store.runSummaries());
ipcMain.handle('run:rename', (_e, projectId, runId, name) => proj(projectId).store.setRunName(runId, name));
// Deleting a run this process is still walking would pull the files out from
// under the runner mid-step (it writes meta/log/outputs as it goes), so refuse
// while it's live and let the caller say why.
ipcMain.handle('run:delete', (_e, projectId, runId) => {
  const entry = proj(projectId);
  if (entry.runner.live.has(runId)) throw new Error('This run is still executing. Wait for it to finish before deleting it.');
  entry.store.deleteRun(runId);
  pushStateFor(entry.id).channels.delete(runId); // drop the patch baseline; the id is gone for good
  return true;
});
// Full snapshot + the rev naming it, for a renderer that fetches one (on first
// view or after a missed patch). The two are minted from the SAME instant and
// recorded as this run's baseline, because the whole patch scheme rests on a rev
// identifying exactly one snapshot on both sides: a patch is "current minus
// baseline", so it only converges when the receiver's content at `base` IS the
// baseline it was diffed against. Reading files fresh but stamping them with the
// last *pushed* rev labelled two different instants the same — anything that
// changed and changed back in between (a task going running -> pending -> running
// across a step-eval requeue) was then absent from the patch and never repaired,
// leaving the canvas silently stale until an unrelated change happened to resend
// the field.
ipcMain.handle('run:snapshot', (_e, projectId, runId) => {
  const entry = proj(projectId);
  const chans = pushStateFor(entry.id).channels;
  const snapshot = entry.store.snapshot(runId);
  const rev = (chans.get(runId)?.rev ?? 0) + 1;
  chans.set(runId, { snapshot, rev });
  return { ...snapshot, rev };
});
ipcMain.handle('run:openFolder', (_e, projectId, runId) => shell.openPath(proj(projectId).store.runDir(runId)));
ipcMain.handle('run:log', (_e, projectId, runId) => proj(projectId).store.readLog(runId));

// --- Workspace binding (target project folder for a run) ---
ipcMain.handle('workspace:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose a target workspace',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
});
// Reveal a run's bound workspace in the OS file manager; path comes from
// meta.json (never trusting a renderer-supplied path).
ipcMain.handle('workspace:open', (_e, projectId, runId) => {
  const dir = proj(projectId).store.readMeta(runId)?.workspace;
  return dir ? shell.openPath(dir) : null;
});

// --- Project tabs (D22): registry surface for the strip, new-tab page & deck ---
function projectListPayload() {
  return {
    tabs: registry.listOpen(),
    active: registry.activeId,
    storage: settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'
  };
}
let droppedReported = false;
ipcMain.handle('project:list', () => {
  const payload = projectListPayload();
  // Restore-time casualties surface exactly once (T17): tabs whose folder was
  // missing at launch. Their recents entries survive for a manual reopen.
  if (!droppedReported) {
    droppedReported = true;
    payload.dropped = droppedTabs;
  }
  return payload;
});
ipcMain.handle('project:open', (_e, folder = null) => {
  const { project, focused } = registry.open(folder);
  updateWindowTitle();
  return { ...projectListPayload(), opened: project.id, focused };
});
ipcMain.handle('project:close', (_e, projectId) => {
  // T13: closing a tab never kills work — the entry (store + runner) stays
  // live in this process; only the tab goes.
  registry.close(projectId);
  updateWindowTitle();
  return projectListPayload();
});
ipcMain.handle('project:activate', (_e, projectId) => {
  registry.activate(projectId);
  updateWindowTitle();
  return projectListPayload();
});
ipcMain.handle('project:reorder', (_e, ids) => {
  registry.reorder(Array.isArray(ids) ? ids : []);
  return projectListPayload();
});
// Per-tab UI state (T8 slim: ids + view modes, never snapshots), persisted so
// restore can put each tab back on its last section/flow/run (T17).
ipcMain.handle('project:saveState', (_e, projectId, state) => {
  registry.setTabState(projectId, state);
});
ipcMain.handle('project:recents', () => registry.listRecents());
ipcMain.handle('project:removeRecent', (_e, folder) => {
  registry.removeRecent(String(folder));
  return registry.listRecents();
});
ipcMain.handle('project:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open a project folder',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths?.length) return null;
  return res.filePaths[0];
});
// Everything the deck needs to deal its cards (4.2): per open tab, the live
// state, the newest run (for its sigil + badge), and the active flow's topology
// (positions from the layout sidecar) for the mini-render.
ipcMain.handle('project:deckData', () => {
  return registry.listOpen().map(tab => {
    const entry = registry.get(tab.id);
    let latestRun = null;
    try {
      const s = entry.store.runSummaries()[0];
      if (s) latestRun = { id: s.id, name: s.name, stage: s.stage };
    } catch { /* unreadable store — card renders without a run */ }
    let topo = null;
    const flowId = tab.state?.activeFlowId ?? tab.state?.runFlowId;
    if (flowId) {
      try {
        const flow = flows.load(flowId);
        const index = new Map(flow.nodes.map((n, i) => [n.id, i]));
        topo = {
          nodes: flow.nodes.map(n => ({ x: n.position.x, y: n.position.y })),
          edges: flow.edges
            .filter(e => index.has(e.source) && index.has(e.target))
            .map(e => [index.get(e.source), index.get(e.target)])
        };
      } catch { /* flow gone — card renders without a topology */ }
    }
    return { ...tab, latestRun, topo };
  });
});
ipcMain.handle('config:get', () => ({ workers: publicSettings().workers }));

// --- Flow definitions (editable workflow graphs) ---
ipcMain.handle('flow:list', () => flows.list());
ipcMain.handle('flow:load', (_e, id) => flows.load(id));
ipcMain.handle('flow:save', (_e, flow) => flows.save(flow));
ipcMain.handle('flow:new', () =>
  flows.create(nodeLibrary.get('code-general-step') ? 'code-general-step' : null));
ipcMain.handle('flow:delete', (_e, id) => flows.remove(id));
// On-save validation for the canvas badge: full rule set, structured findings.
ipcMain.handle('flow:lint', (_e, id) =>
  lintFlow(flows.load(id), { templates: nodeLibrary.listFull() }));

// Raw YAML source for the code viewer/editor. Allows users (and AIs) to inspect
// and hand-edit the canonical *.flow.yaml while the canvas works on the model.
ipcMain.handle('flow:toYaml', (_e, flow) => {
  try { return serializeFlow(flow); }
  catch (e) { throw new Error('serialize: ' + e.message); }
});
ipcMain.handle('flow:saveFromYaml', (_e, id, yamlText) => {
  if (typeof yamlText !== 'string') throw new Error('yamlText must be a string');
  const parsed = parseFlow(yamlText); // validates + produces canonical model (no pos)
  // Preserve any existing layout positions for nodes that survive the edit.
  let layout = {};
  try {
    layout = JSON.parse(fs.readFileSync(flows.layoutPath(id), 'utf8')) || {};
  } catch {}
  const nodes = parsed.nodes.map((n, i) => {
    const p = layout[n.id] || (n.position ?? { x: 140 + (i % 5) * 30, y: 60 + Math.floor(i / 5) * 110 });
    return { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } };
  });
  return flows.save({ ...parsed, nodes });
});
ipcMain.handle('flow:lintYaml', (_e, yamlText) =>
  lintText(yamlText, { templates: nodeLibrary.listFull() }));

// Exact on-disk source (the committed *.flow.yaml). Useful to see what was
// last persisted vs the live in-memory model.
ipcMain.handle('flow:loadSource', (_e, id) => {
  const p = flows.flowPath(id);
  if (!fs.existsSync(p)) throw new Error('No .flow.yaml for ' + id);
  return fs.readFileSync(p, 'utf8');
});

// --- Node Library (reusable AI node templates) ---
ipcMain.handle('node:list', () => nodeLibrary.listFull());
ipcMain.handle('node:save', (_e, tpl) => nodeLibrary.save(tpl));
ipcMain.handle('node:new', () => nodeLibrary.create());
ipcMain.handle('node:delete', (_e, id) => nodeLibrary.remove(id));

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
  // T2a: applies to projects opened from now on; already-open tabs keep the
  // store they were opened with.
  if (patch.projectStorage === 'workspace' || patch.projectStorage === 'appdata') {
    settings.projectStorage = patch.projectStorage;
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
  const models = (data.data ?? []).map(m => ({
    id: m.id,
    name: m.name ?? m.id,
    contextLength: m.context_length ?? null,
    supportsTools: (m.supported_parameters || []).includes('tools')
  }));
  // Remember which models can call tools natively so the agent loop can pick
  // the native path per worker (survives restarts via settings.json).
  settings.modelCapabilities = Object.fromEntries(
    models.filter(m => m.supportsTools).map(m => [m.id, true])
  );
  persistSettings();
  rebuildRuntimeConfig();
  return models;
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
