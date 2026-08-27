import { app, BrowserWindow, ipcMain, shell, Menu, dialog, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createApi } from '../core/api.js';
import { APPROVAL_MODES } from '../core/stackRunner.js';
import { SAFETY_MODEL_CANDIDATES } from '../core/safetyCheck.js';
import { DEFAULT_PROJECT_ID } from '../core/projects.js';
import { lintText } from '../core/stacklang/lint.js';
import { resolveFlow, exposedFields, diffOverrides } from '../src/flowTypes.js';
import { parseFlow } from '../core/stacklang/parse.js';
import { serializeFlow } from '../core/stacklang/serialize.js';
import { callModel } from '../core/adapters/index.js';
import {
  PROVIDER_IDS, KEYED_PROVIDERS, SUBSCRIPTION_PROVIDERS, DEFAULT_PRIORITY,
  CURATED_MODELS, TEST_MODELS,
  catalogFromOpenRouter, factsFromCatalog, normalizeModelSets,
  popularityFromOpenRouter, normalizeModelPopularity
} from '../core/modelSource.js';
// Subscription (CLI-delegation) plumbing: sign-in detection + binary
// resolution. Presence checks only — no token is ever read (DESIGN-SPEC.md §6).
import { LEVELS } from '../core/levels.js';
import { APP_NAME, LOG_TAG, LEGACY_APP_DIRS } from '../core/brand.js';
import { migrateUserDataDir } from '../core/migrate.js';
import { bootKernel } from '../core/v2.js';
import { createV2HostBridge } from '../core/v2Host.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Where the app's own code and bundled assets live. When packaged this is
// INSIDE app.asar — readable, never writable (fs.mkdirSync there fails with
// ENOTDIR because the archive is a file, not a directory).
const projectRoot = path.join(__dirname, '..');
// --- One-shot userData migration into the renamed profile (D29) -----------
// Electron derives userData from the app name, so the rename silently orphans
// every existing install's settings.json, project registry and seeded flows.
// This MUST run before anything below captures a path — dataRoot and
// settingsPath both resolve eagerly, at module load.
//
// Two legacy names, because the two builds disagreed: packaged installs used
// electron-builder's productName, dev used package.json `name`. The rules (and
// the guards that keep this from clobbering an existing profile) live in
// core/migrate.js so they can be tested without Electron.
migrateUserDataDir({
  appDataRoot: app.getPath('appData'),
  userDataDir: app.getPath('userData'),
  legacyNames: LEGACY_APP_DIRS,
  log: msg => console.log(`${LOG_TAG} ${msg}`)
});

// Where mutable state lives: the repo checkout in dev, userData when packaged.
// flows/, nodes/ and runs/ are all read-write stores, so they must never be
// resolved against projectRoot in a packaged build. The engine does the
// seeding and directory creation from these two roots.
const dataRoot = app.isPackaged ? app.getPath('userData') : projectRoot;

// One instance per runs/ directory, claimed before anything reads or writes it.
// runs/ is a shared mutable store and liveness is tracked in process memory
// (StackRunner.live), so a second instance cannot tell a run this process is
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

// --- The engine (DESIGN-SPEC.md §8) ---
// Stores, settings, provider resolution, the project registry and the push
// plumbing all live in core/engine.js now, so the headless supervisor and the
// CLI can drive exactly the same app this window does. What stays here is what
// only a desktop app has: windows, menus, dialogs, notifications, lifecycle.
const engine = createEngine({
  projectRoot,
  dataRoot,
  userDataDir: app.getPath('userData'),
  // The renderer is the consumer: events go over IPC unchanged, so the preload
  // contract and every existing listener are untouched.
  emit: (type, payload) => win?.webContents.send(type, payload),
  canEmit: () => Boolean(win) && !win.isDestroyed(),
  // T7/T9: only the ACTIVE tab is worth diffing for. Background projects keep
  // executing (the engine is main-process) and resync from files on activation.
  shouldPush: projectId => projectId === registry.activeId,
  log: msg => console.log(`${LOG_TAG} ${msg}`),
  warn: msg => console.warn(`${LOG_TAG} ${msg}`)
});
const {
  baseConfig, flows, nodeLibrary, toolLibrary, registry, runtimeConfig, settings,
  persistSettings, rebuildRuntimeConfig, publicSettings,
  hasKey, subscriptionStatus, resolveModelSource, effectiveSafetyModel,
  broadcastActivity, pushStateFor, dropPushState
} = engine;

const isMac = process.platform === 'darwin';

// Native window chrome, themed to the app's --app title-bar token so the
// custom title bar we render in the renderer flows seamlessly into the OS
// window controls. Colors mirror the light/dark tokens in styles.css.
const CHROME = {
  light: { color: '#1f2724', symbolColor: '#e6ebe8', height: 40 },
  dark:  { color: '#0f1512', symbolColor: '#dfe7e2', height: 40 }
};

let win = null;
let v2HostPromise = null;
let detachV2UiExtensions = null;

async function v2Host() {
  if (!v2HostPromise) {
    v2HostPromise = bootKernel({
      settings,
      profile: 'flyt-desktop',
      runsRoot: registry.defaultRunsDir,
      approvalMode: settings.approvalMode ?? 'ask',
    }).then(booted => {
      if (!booted) return null;
      const bridge = createV2HostBridge(booted);
      detachV2UiExtensions = bridge.subscribe(rows => {
        if (win && !win.isDestroyed()) win.webContents.send('v2:ui-extensions-change', rows);
      });
      return { booted, bridge };
    });
  }
  return v2HostPromise;
}

// --- Approval-gate nudge (CHAT-RUN rework) ---
// A run parked at an approval gate waits forever if the user doesn't notice.
// The renderer reports gate state (app:approvalGate); while the window is
// unfocused we raise an OS notification and flash the taskbar until the gate
// settles or the window regains focus. One notice at a time — a new gate
// replaces the old one.
let approvalNotice = null;

function clearApprovalSignal() {
  approvalNotice?.close();
  approvalNotice = null;
  if (win && !win.isDestroyed()) win.flashFrame(false);
}

// Browser-style session restore (T17). Tabs whose folder disappeared are
// dropped (recents entry stays); the renderer surfaces them once via
// project:list.
const { dropped: droppedTabs } = registry.restore(settings.projects ?? {});

// Scratch retirement (L6): the unbound scratch tab is gone. Its existing runs
// (app-root runs/) migrate once into an appdata project named 'scratch' so no
// history is orphaned. Non-destructive — the originals stay in place until the
// user clears them — and guarded by a flag so it never runs twice. The
// previously-active tab keeps focus; the migrated project just joins the strip.
function migrateScratchIfNeeded() {
  if (settings.scratchMigrated) return;
  settings.scratchMigrated = true;
  let runIds = [];
  try {
    runIds = fs.readdirSync(registry.defaultRunsDir)
      .filter(d => fs.existsSync(path.join(registry.defaultRunsDir, d, 'meta.json')));
  } catch { /* no app-root runs/ — nothing to migrate */ }
  if (!runIds.length) { persistSettings(); return; }
  const prevActive = registry.activeId;
  const { project } = registry.createAppdata('scratch');
  for (const id of runIds) {
    try {
      fs.cpSync(path.join(registry.defaultRunsDir, id), path.join(project.appDir, 'runs', id), { recursive: true });
    } catch (e) {
      console.warn(`${LOG_TAG} scratch migrate: skipped ${id} — ${e.message}`);
    }
  }
  // Don't steal focus from a restored tab; the migrated project is just added.
  if (prevActive != null) registry.activeId = prevActive;
  persistSettings();
  console.log(`${LOG_TAG} migrated ${runIds.length} scratch run(s) into ${project.id}`);
}
migrateScratchIfNeeded();

function updateWindowTitle() {
  if (!win || win.isDestroyed()) return;
  // Projectless (L6): no tab open — the app's own name, no project.
  if (registry.activeId == null) { win.setTitle(APP_NAME); return; }
  const entry = registry.get(registry.activeId);
  // T16: <project> — Flyt. Both bound folders and appdata projects name the
  // window; the legacy default (were it ever active) is just the app.
  win.setTitle(entry.kind === 'default' ? APP_NAME : `${entry.name} — ${APP_NAME}`);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: APP_NAME,
    // Windows/Linux read the window icon from here; on macOS the bundle owns it.
    // Without this, dev runs and Linux builds show the default Electron icon.
    icon: path.join(projectRoot, 'build', 'icon.png'),
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
  // Regaining focus answers the approval-gate nudge by itself — stop the
  // taskbar flash and dismiss the notification the moment the user is back.
  win.on('focus', clearApprovalSignal);
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

// --- The command surface (DESIGN-SPEC.md §8) ---
// Commands that don't need a window live in core/api.js so the CLI, the HTTP
// server and this renderer all reach the same implementation. IPC is positional
// and the map is keyword, so each binding below names its arguments once —
// that table IS the adapter, and it is the only thing duplicated.
const api = createApi(engine);
const bindIpc = (name, toArgs = () => ({})) =>
  ipcMain.handle(name, (_e, ...args) => api.invoke(name, toArgs(...args)));

// D61: this is the production host-to-renderer bridge. Only the host's cloned
// list crosses IPC; the generic plugin RPC and Cordis context stay main-side.
ipcMain.handle('v2:build', async () => (await v2Host())?.bridge.build() ?? null);

bindIpc('flow:list');
bindIpc('flow:load', id => ({ id }));
bindIpc('flow:lint', id => ({ id }));
bindIpc('tool:list');
bindIpc('config:get');
bindIpc('flow:run', (projectId, flowId, userInput = '', workspaceDir = null, approvalMode = null, launch = null) =>
  ({ projectId, flowId, userInput, workspaceDir, approvalMode, launch }));
bindIpc('run:list', projectId => ({ projectId }));
bindIpc('run:log', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:snapshot', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:approve', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:reject', (projectId, runId, reason) => ({ projectId, runId, reason }));
bindIpc('run:resume', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:stop', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:pause', (projectId, runId) => ({ projectId, runId }));
bindIpc('run:restartNode', (projectId, runId, nodeId, guidance = '', worker = null) =>
  ({ projectId, runId, nodeId, guidance, worker }));
bindIpc('run:followUp', (projectId, runId, text) => ({ projectId, runId, text }));
bindIpc('run:answerInput', (projectId, runId, text) => ({ projectId, runId, text }));
// The loop (DESIGN-SPEC.md §8): the same commands the CLI and the HTTP server bind,
// so the desktop view is a third front door onto one implementation rather than
// a second implementation of the same panel.
bindIpc('loop:start', (projectId, opts = {}) => ({ projectId, ...opts }));
bindIpc('loop:stop', projectId => ({ projectId }));
bindIpc('loop:status', projectId => ({ projectId }));
bindIpc('loop:report', projectId => ({ projectId }));
bindIpc('loop:log', projectId => ({ projectId }));
bindIpc('ledger:totals', (projectId, opts = {}) => ({ projectId, ...opts }));

// The reference library (D36 P1.6). These existed only on the headless server,
// so from the desktop app the library was invisible AND unreachable - you could
// not list what was cloned, let alone add a repository. Same commands, third
// front door.
bindIpc('ref:list', () => ({}));
bindIpc('ref:add', (opts = {}) => ({ ...opts }));
bindIpc('ref:remove', name => ({ name }));
bindIpc('ref:update', (name = null) => ({ name }));
bindIpc('ref:search', (opts = {}) => ({ ...opts }));
bindIpc('ref:read', ref => ({ ref }));
// Clone a repository into a folder and open it as a project - the other half
// of "point this app at someone else's code": read it, or work on it.
bindIpc('repo:clone', (opts = {}) => ({ ...opts }));
bindIpc('ledger:check', (projectId, taskId = null) => ({ projectId, taskId }));
bindIpc('task:list', (projectId, status = null) => ({ projectId, status }));
bindIpc('task:add', (projectId, task = {}) => ({ projectId, ...task }));
bindIpc('task:escalate', (projectId, id, reason = 'failed') => ({ projectId, id, reason }));
bindIpc('task:release', (projectId, id, status = 'queued') => ({ projectId, id, status }));
bindIpc('task:remove', (projectId, id, force = false) => ({ projectId, id, force }));
bindIpc('task:get', (projectId, id) => ({ projectId, id }));
bindIpc('task:update', (projectId, id, patch = {}) => ({ projectId, id, ...patch }));
bindIpc('task:ready', projectId => ({ projectId }));
bindIpc('task:stats', projectId => ({ projectId }));
bindIpc('work:diff', (projectId, taskId, base = null) => ({ projectId, taskId, base }));
bindIpc('work:verify', (projectId, taskId) => ({ projectId, taskId }));
bindIpc('run:live', (projectId = null) => ({ projectId }));
bindIpc('chat:threads', projectId => ({ projectId }));
bindIpc('chat:read', (projectId, threadId) => ({ projectId, threadId }));
bindIpc('chat:new', projectId => ({ projectId }));
bindIpc('chat:send', (projectId, threadId, text, worker = null) => ({ projectId, threadId, text, worker }));
bindIpc('chat:stop', (projectId, threadId) => ({ projectId, threadId }));
bindIpc('chat:delete', (projectId, threadId) => ({ projectId, threadId }));
bindIpc('chat:tools');
bindIpc('feedback:stats', projectId => ({ projectId }));
bindIpc('feedback:digest', (projectId, enqueue = false) => ({ projectId, enqueue }));
// The benchmark trend (§12.1) — the only number on the Loop view that answers
// "is this getting better" rather than "what is it doing right now".
bindIpc('archive:trend', (projectId, limit = 30) => ({ projectId, limit }));

// One engine, one entry point: pick a workflow, type a request, run it.
// The user input becomes the flow's User Input node content for that run.
// approvalMode rides in from the chatbox picker (DESIGN-SPEC.md §5): the mode
// shown beside the Run button is the mode the run is captured under, so what
// the user saw when they pressed Run is what governs it for its whole life.
// Omitted (or unrecognized) falls back to the saved default.
// The chat run reports gate state so a parked workflow can find its user:
// 'pending' while gated (notify + flash only when the window is unfocused —
// a user already looking at the dialog needs no nudge), 'resolved' on settle.
ipcMain.handle('app:approvalGate', (_e, info = {}) => {
  if (!win || win.isDestroyed()) return;
  if (info.state === 'resolved') { clearApprovalSignal(); return; }
  // A new gate replaces any previous gate's notice.
  approvalNotice?.close();
  approvalNotice = null;
  // A user already looking at the dialog needs no nudge.
  if (win.isFocused()) { win.flashFrame(false); return; }
  win.flashFrame(true);
  if (!Notification.isSupported()) return;
  approvalNotice = new Notification({
    title: String(info.title ?? `Approval needed — ${APP_NAME}`),
    body: String(info.body ?? 'A workflow is paused until you approve or reject it.')
  });
  approvalNotice.on('click', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  approvalNotice.show();
});
// Continue a run the app died in the middle of. Completed nodes are kept and
// not re-executed (V1 task 7). RUN-CONTROL: also releases a soft-paused run —
// the runner resolves the pause gate and the walk clears meta.paused itself.
// Hard stop a live run (RUN-CONTROL): aborts in-flight model calls, settles
// any pending approval/pause gate, marks the run 'cancelled' with cancelledAt,
// and frees the live registry — which is what unblocks run:delete below.
// Soft pause (RUN-CONTROL): the run holds at the next wave boundary — the wave
// in flight always settles first. meta.paused flips true only once the hold
// has actually landed; run:resume releases it.
// Re-run one node and everything downstream of it (RUN-CONTROL), with optional
// guidance injected into the retry prompt. Only on a non-live run.
// Fork a finished run at a node (RUN-CONTROL): upstream outputs are preserved
// as context, downstream nodes re-run in the copy.
ipcMain.handle('run:branch', (_e, projectId, runId, nodeId) => proj(projectId).runner.branch(runId, nodeId));
// Plain-language status read on one node (RUN-CONTROL): status, (partial)
// output, retrospective, log tail, and a model-written summary.
ipcMain.handle('run:investigateNode', (_e, projectId, runId, nodeId) =>
  proj(projectId).runner.investigateNode(runId, nodeId));
// Summary nodes (DESIGN-SPEC.md §7): summarize one or more node outputs into
// a run artifact (summaries/<key>.md + index.json); delete removes both; move
// persists a dragged card's canvas position.
ipcMain.handle('run:summarize', (_e, projectId, runId, sourceIds, position = null) =>
  proj(projectId).runner.summarizeOutputs(runId, sourceIds, { position }));
ipcMain.handle('run:deleteSummary', (_e, projectId, runId, summaryId) =>
  proj(projectId).runner.deleteSummary(runId, summaryId));
ipcMain.handle('run:moveSummary', (_e, projectId, runId, summaryId, position) =>
  proj(projectId).runner.moveSummary(runId, summaryId, position));
// Reply to a finished run (DECISIONS.md D21): the flow grows with a continuation
// subgraph and the walk executes it; completed nodes are never re-run.
// Answer a run parked at the refiner's awaiting_input gate (DECISIONS.md D27).
// Distinct from run:followUp — this closes an in-flight question and re-runs
// the refine node with the answer; it does not open a new follow-up turn.
// Summaries, not bare ids: the list names, groups and sorts runs, and reading
// meta + prompt per run is a handful of small synchronous reads.
ipcMain.handle('run:rename', (_e, projectId, runId, name) => proj(projectId).store.setRunName(runId, name));
// Deleting a run this process is still walking would pull the files out from
// under the runner mid-step (it writes meta/log/outputs as it goes), so refuse
// while it's live and let the caller say why.
ipcMain.handle('run:delete', (_e, projectId, runId) => {
  const entry = proj(projectId);
  if (entry.runner.live.has(runId)) throw new Error('This run is still executing. Wait for it to finish before deleting it.');
  entry.store.deleteRun(runId);
  entry.store.deleteComparisonsFor(runId); // P2: pairings naming the run go with it
  pushStateFor(entry.id).channels.delete(runId); // drop the patch baseline; the id is gone for good
  return true;
});

// --- Comparison records (DECISIONS.md D27) ---
// compare:begin mints the shared group id BEFORE the two runs start (their
// metas carry it from creation); compare:save persists the record and stamps
// both runs (label A/B) — including retroactively for rematch/manual pairs.
ipcMain.handle('compare:begin', (_e, projectId) => ({ id: proj(projectId).store.newComparisonId() }));
ipcMain.handle('compare:save', (_e, projectId, rec) => proj(projectId).store.saveComparison(rec ?? {}));
ipcMain.handle('compare:list', (_e, projectId) => proj(projectId).store.listComparisons());
// P3 (T13): judge a pair. The runner makes the blind compare-role call and
// returns the parsed verdict; this handler owns the record — explicit
// comparisonId when the renderer knows it, else the newest record for the
// pair, else a fresh 'manual' one (judging an unrecorded pair still lands in
// a record, so the verdict is never orphaned). Re-judging replaces verdict.
ipcMain.handle('run:judge', async (_e, projectId, runIdA, runIdB, comparisonId = null) => {
  const entry = proj(projectId);
  const verdict = await entry.runner.judgeComparison(runIdA, runIdB, { judgeModel: settings.judgeModel ?? null });
  const records = entry.store.listComparisons();
  let rec = comparisonId ? records.find(c => c.id === comparisonId) : null;
  rec ??= records.find(c => c.runIds?.[0] === runIdA && c.runIds?.[1] === runIdB);
  rec ??= entry.store.saveComparison({ runIds: [runIdA, runIdB], origin: 'manual' });
  return entry.store.saveComparisonVerdict(rec.id, verdict);
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
ipcMain.handle('run:openFolder', (_e, projectId, runId) => shell.openPath(proj(projectId).store.runDir(runId)));

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
// Auto-create an appdata project from the projectless lander's first prompt
// (L5): the slug is derived + deduped main-side so the mkdir is atomic with the
// name. Returns the same shape as project:open so the renderer opens the tab.
ipcMain.handle('project:create', (_e, promptOrName = '') => {
  const { project } = registry.createAppdata(String(promptOrName ?? ''));
  updateWindowTitle();
  return { ...projectListPayload(), opened: project.id, focused: false };
});
ipcMain.handle('project:rename', (_e, projectId, name) => {
  registry.rename(projectId, String(name ?? ''));
  updateWindowTitle();
  return projectListPayload();
});
// Adopt an appdata project into a real folder (Phase 6, "Move to folder…"): the
// registry migrates the files and swaps the tab in place, returning the id remap
// so the renderer can re-key its per-tab bundles.
ipcMain.handle('project:adopt', (_e, projectId, folder) => {
  const { oldId, newId } = registry.adoptAppdata(projectId, folder);
  dropPushState(oldId); // the old id is gone for good — drop its push channels
  updateWindowTitle();
  return { ...projectListPayload(), oldId, opened: newId };
});
// Reveal a tab's project directory in the OS file manager (folder tabs open the
// bound workspace; appdata tabs open their app-managed dir). The path comes from
// Open one file inside a run — today the tool-result artifacts the inspector
// links (DESIGN-SPEC.md §5). The path comes from the renderer, so it is resolved
// against the run directory and rejected if it escapes: a relative path from
// a record is data, and data does not get to name a file outside the run.
ipcMain.handle('run:openArtifact', (_e, projectId, runId, relPath) => {
  const dir = path.resolve(proj(projectId).store.runDir(runId));
  const target = path.resolve(dir, String(relPath ?? ''));
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Path escapes the run directory');
  if (!fs.existsSync(target)) throw new Error('No such file in this run');
  return shell.openPath(target);
});
// the registry entry, never from the renderer.
ipcMain.handle('project:reveal', (_e, projectId) => {
  const e = registry.get(projectId);
  const dir = e.folder ?? e.appDir;
  return dir ? shell.openPath(dir) : null;
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

// --- Flow definitions (editable workflow graphs) ---
ipcMain.handle('flow:save', (_e, flow) => flows.save(flow));
ipcMain.handle('flow:new', () =>
  flows.create(nodeLibrary.get('work') ? 'work' : null));
ipcMain.handle('flow:delete', (_e, id) => flows.remove(id));
// Where the .flow.yaml files actually live, and a way to open that folder.
// In a packaged build this is userData/flows (D28), which is otherwise hard to
// find — and it's the folder `npm run flow -- adopt` reads from when promoting
// a flow designed in the installed app into a shipped default.
ipcMain.handle('flow:folder', () => ({ dir: flows.rootDir, packaged: app.isPackaged }));
ipcMain.handle('flow:openFolder', () => shell.openPath(flows.rootDir));
// On-save validation for the canvas badge: full rule set, structured findings.

// --- Configs (DECISIONS.md D27): modes as first-class bundles ---
// A config IS a mode in the flow's modes: block; these are thin passes into
// the FlowStore helpers (the .flow.yaml stays the source of truth).
ipcMain.handle('flow:saveConfig', (_e, flowId, modeId, config = {}) =>
  flows.saveConfig(flowId, String(modeId ?? ''), config && typeof config === 'object' ? config : {}));
ipcMain.handle('flow:duplicateConfig', (_e, flowId, sourceId, newId, name = null) =>
  flows.duplicateConfig(flowId, String(sourceId ?? ''), String(newId ?? ''), { name: name == null ? null : String(name) }));
// Promote a finished run's launch configuration to a named config on its flow:
// meta.launchOverrides becomes the override map, the run's modeId (if any) the
// derivedFrom lineage. Closes the tweak → run → it-works → save-it loop.
ipcMain.handle('flow:promoteRunConfig', (_e, projectId, runId, name = null) => {
  const entry = proj(projectId);
  const meta = entry.store.readMeta(runId);
  if (!meta?.flowId) throw new Error('Only flow runs can be promoted to a config.');
  return { flowId: meta.flowId, ...flows.promoteRunConfig(meta.flowId, meta, { name: name == null ? null : String(name) }) };
});
// Per-flow config summaries with diff-against-Default badges (P1 picker
// upgrade): every flow's configs, each with its description/lineage and the
// human-readable badge lines the pickers render. Keyed by flow id; flows
// without configs are absent.
ipcMain.handle('flow:listConfigs', () => {
  const templates = nodeLibrary.listFull();
  const out = {};
  for (const f of flows.list()) {
    if (!f.modes?.length) continue;
    try {
      const flow = flows.load(f.id);
      const resolved = resolveFlow(flow, templates);
      out[f.id] = Object.entries(flow.modes ?? {}).map(([id, m]) => ({
        id,
        name: m?.name || id,
        ...(m?.description ? { description: m.description } : {}),
        ...(m?.derivedFrom ? { derivedFrom: m.derivedFrom } : {}),
        badges: diffOverrides(resolved, m?.overrides).map(b => b.text)
      }));
    } catch { /* unresolvable flow — picker shows it without badges */ }
  }
  return out;
});

// The exposed run inputs (DECISIONS.md D27) of a flow: which node fields the
// author surfaced as composer controls, resolved so the renderer can build the
// controls without re-parsing YAML. Each: { nodeId, title, field, current }.
ipcMain.handle('flow:launchInputs', (_e, id) => {
  try {
    const resolved = resolveFlow(flows.load(id), nodeLibrary.listFull());
    const out = [];
    for (const n of resolved.nodes) {
      for (const field of exposedFields(n)) {
        out.push({ nodeId: n.id, title: n.data?.title ?? n.id, field, current: n.data?.[field] ?? null });
      }
    }
    // Two different things, deliberately kept apart (D36 P1.3): an OVERRIDE is
    // a knob on a node the author chose to surface; an INPUT is content the
    // flow declared it needs. They travel as two fields — an array with an
    // extra property does not survive structuredClone over IPC.
    const declared = resolved.nodes.find(n => n.type === 'inputs')?.data?.declared ?? [];
    return { fields: out, declared };
  } catch { return { fields: [], declared: [] }; }
});

// Raw YAML source for the code viewer/editor. Allows users (and AIs) to inspect
// and hand-edit the canonical *.flow.yaml while the canvas works on the model.
ipcMain.handle('flow:toYaml', (_e, flow) => {
  try { return serializeFlow(flow); }
  catch (e) { throw new Error('serialize: ' + e.message); }
});

// --- Tool Library (tools/<id>.json) ---
// Read-only over IPC in P1: the renderer uses it to validate grants against
// what actually exists instead of a hardcoded array. Authoring arrives with
// the Tools page (DESIGN-SPEC.md §5).
ipcMain.handle('tool:folder', () => ({ dir: toolLibrary.rootDir, packaged: app.isPackaged }));

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
  lintText(yamlText, {
    templates: nodeLibrary.listFull(), library: toolLibrary.catalog(),
    // Sub-flow rules resolve references against the whole library (D36 P3.4).
    flows: flows.list().map(f => { try { return flows.load(f.id); } catch { return null; } }).filter(Boolean)
  }));

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
  // Provider keys are one-way, like the legacy OpenRouter key: only overwrite
  // when a non-empty string is provided, so the renderer can save other
  // settings without ever knowing (or clearing) a key.
  if (patch.providerKeys && typeof patch.providerKeys === 'object') {
    settings.providers = { ...(settings.providers ?? {}) };
    for (const [p, key] of Object.entries(patch.providerKeys)) {
      if (KEYED_PROVIDERS.includes(p) && typeof key === 'string' && key.trim()) {
        settings.providers[p] = { ...(settings.providers[p] ?? {}), apiKey: key.trim() };
      }
    }
  }
  // Subscription opt-ins (DESIGN-SPEC.md §6): per provider —
  // { enabled?, home?, cliPath? }. enabled is the explicit consent gate;
  // empty-string home/cliPath clears the override. No token ever passes here.
  if (patch.subscriptions && typeof patch.subscriptions === 'object') {
    settings.subscriptions = { ...(settings.subscriptions ?? {}) };
    for (const p of SUBSCRIPTION_PROVIDERS) {
      const inc = patch.subscriptions[p];
      if (!inc || typeof inc !== 'object') continue;
      const next = { ...(settings.subscriptions[p] ?? {}) };
      if (typeof inc.enabled === 'boolean') next.enabled = inc.enabled;
      for (const field of ['home', 'cliPath']) {
        if (typeof inc[field] !== 'string') continue;
        const v = inc[field].trim();
        if (v) next[field] = v; else delete next[field];
      }
      settings.subscriptions[p] = next;
    }
  }
  if (patch.kimiKeyKind === 'platform' || patch.kimiKeyKind === 'code') {
    settings.providers = { ...(settings.providers ?? {}) };
    settings.providers.kimi = { ...(settings.providers.kimi ?? {}), keyKind: patch.kimiKeyKind };
  }
  if (Array.isArray(patch.providerPriority)) {
    const seen = patch.providerPriority.filter(p => PROVIDER_IDS.includes(p));
    settings.providerPriority = [...new Set([...seen, ...DEFAULT_PRIORITY])];
  }
  if (Array.isArray(patch.activeModels)) {
    settings.activeModels = patch.activeModels
      .filter(m => m && typeof m.id === 'string' && m.id.trim())
      .map(m => ({
        id: m.id.trim(),
        source: PROVIDER_IDS.includes(m.source) ? m.source : 'auto',
        enabled: m.enabled !== false,
        pinned: m.pinned !== false
      }));
  }
  // Named model sets (D36). Sent whole rather than patched per set, so
  // deleting one is just its absence — the same shape activeModels uses.
  if (patch.modelSets && typeof patch.modelSets === 'object') {
    settings.modelSets = normalizeModelSets(patch.modelSets);
  }
  if (patch.workers && typeof patch.workers === 'object') {
    settings.workers = { ...settings.workers };
    for (const [name, w] of Object.entries(patch.workers)) {
      if (!baseConfig.workers[name]) continue;
      if (w?.provider && w?.model) settings.workers[name] = { provider: w.provider, model: w.model };
      // An explicit null CLEARS the override back to config.json's default.
      // Without a way to un-set one, the loop's model pin would be a one-way
      // door: you could choose a model but never go back to effort bands.
      else if (w === null || !w?.model) delete settings.workers[name];
    }
  }
  // A model per effort band for the loop (DESIGN-SPEC.md §8). Sent whole rather than
  // patched per band, the same shape activeModels uses, so clearing one band is
  // simply its absence. Unknown band names are dropped rather than stored.
  if (patch.loopModels && typeof patch.loopModels === 'object') {
    const out = {};
    for (const band of LEVELS) {
      const id = patch.loopModels[band];
      if (typeof id === 'string' && id.trim()) out[band] = id.trim();
    }
    settings.loopModels = out;
  }
  // T2a: applies to projects opened from now on; already-open tabs keep the
  // store they were opened with.
  if (patch.projectStorage === 'workspace' || patch.projectStorage === 'appdata') {
    settings.projectStorage = patch.projectStorage;
  }
  // The default new runs inherit. 'node' stays accepted so an existing config
  // can keep the per-node behavior, but it isn't offered in the UI.
  if (APPROVAL_MODES.includes(patch.approvalMode)) {
    settings.approvalMode = patch.approvalMode;
  }
  // 'auto' or an explicit model id. Not restricted to the candidate list: a
  // user who wants their own cheap model for this should be able to name it.
  if (typeof patch.safetyModel === 'string' && patch.safetyModel.trim()) {
    settings.safetyModel = patch.safetyModel.trim();
  }
  // The comparison judge's model (DECISIONS.md D27): an explicit model id,
  // or '' to clear back to the default worker. Same free-id rule as the
  // safety model — resolved at call time, so an unrouted id fails then, not here.
  if (typeof patch.judgeModel === 'string') {
    const v = patch.judgeModel.trim();
    if (v) settings.judgeModel = v; else delete settings.judgeModel;
  }
  persistSettings();
  rebuildRuntimeConfig();
  return publicSettings();
});

// Per-provider model catalogs (DESIGN-SPEC.md §6): openrouter keeps its live
// fetch; anthropic/openai/kimi return short curated lists (their model
// endpoints are inconsistent — a static list + the free-text field avoids
// another failure mode).
ipcMain.handle('models:list', async (_e, provider = 'openrouter') => {
  if (provider !== 'openrouter') {
    if (!CURATED_MODELS[provider]) throw new Error(`No model catalog for provider "${provider}".`);
    return CURATED_MODELS[provider].map(m => ({ ...m, contextLength: null }));
  }
  if (!settings.providers?.openrouter?.apiKey) throw new Error('No OpenRouter API key saved. Add one in Settings first.');
  const res = await fetch('https://openrouter.ai/api/v1/models', {
    headers: { 'Authorization': `Bearer ${settings.providers.openrouter.apiKey}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter models ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const models = catalogFromOpenRouter(data);
  // Remember which models can call tools natively so the agent loop can pick
  // the native path per worker (survives restarts via settings.json).
  settings.modelCapabilities = Object.fromEntries(
    models.filter(m => m.supportsTools).map(m => [m.id, true])
  );
  // DECISIONS.md D36: keep the context/price/tools facts too. They were fetched
  // anyway, and a picker that shows what a model costs is the whole point.
  settings.modelFacts = factsFromCatalog(models, settings.modelFacts);
  persistSettings();
  rebuildRuntimeConfig();
  return models;
});

const MODEL_POPULARITY_CACHE_MS = 6 * 60 * 60 * 1000;

// Public OpenRouter adoption data, kept separate from the model catalog so a
// rankings outage or rate limit never makes models disappear. The endpoint's
// default window is the trailing 30 completed UTC days.
ipcMain.handle('models:rankings', async (_e, force = false) => {
  const cached = normalizeModelPopularity(settings.modelPopularity);
  const fetchedMs = Date.parse(cached?.fetchedAt ?? '');
  if (!force && cached && Number.isFinite(fetchedMs) && Date.now() - fetchedMs < MODEL_POPULARITY_CACHE_MS) {
    return { ...cached, stale: false };
  }
  if (!settings.providers?.openrouter?.apiKey) {
    if (cached) return { ...cached, stale: true, warning: 'Connect OpenRouter to refresh popularity.' };
    throw new Error('No OpenRouter API key saved. Add one in Settings to load popularity data.');
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/datasets/rankings-daily?period=day', {
      headers: { 'Authorization': `Bearer ${settings.providers.openrouter.apiKey}` }
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenRouter rankings ${res.status}: ${body.slice(0, 300)}`);
    }
    const ranking = {
      ...popularityFromOpenRouter(await res.json()),
      fetchedAt: new Date().toISOString()
    };
    if (!ranking.creators.length) throw new Error('OpenRouter rankings returned no model creators.');
    settings.modelPopularity = ranking;
    persistSettings();
    return { ...ranking, stale: false };
  } catch (err) {
    if (cached) return { ...cached, stale: true, warning: String(err?.message ?? err) };
    throw err;
  }
});

// The Settings "Test" button (DESIGN-SPEC.md §6): one tiny call through the
// adapter, so a bad key is caught here rather than three nodes into a run.
ipcMain.handle('provider:test', async (_e, provider) => {
  if (provider === 'mock') return { ok: true };
  if (!PROVIDER_IDS.includes(provider)) return { ok: false, error: `Unknown provider "${provider}".` };
  try {
    if (!hasKey(provider)) {
      throw new Error(SUBSCRIPTION_PROVIDERS.includes(provider)
        ? `${provider} is not connected — enable it and sign in via the vendor CLI first.`
        : `No API key saved for ${provider} yet.`);
    }
    const keyKind = settings.providers?.kimi?.keyKind ?? 'platform';
    const model = provider === 'kimi'
      ? (keyKind === 'code' ? TEST_MODELS.kimiCode : TEST_MODELS.kimiPlatform)
      : TEST_MODELS[provider];
    // Subscription targets get their overrides stamped exactly like a real
    // call would (resolveModelSource) — a CLI round trip takes a few seconds.
    const sub = SUBSCRIPTION_PROVIDERS.includes(provider) ? settings.subscriptions?.[provider] : null;
    await callModel({
      provider, model,
      apiKey: settings.providers?.[provider]?.apiKey ?? null,
      ...(provider === 'kimi' ? { keyKind } : {}),
      ...(sub?.home ? { cliHome: sub.home } : {}),
      ...(sub?.cliPath ? { cliPath: sub.cliPath } : {}),
      system: '', prompt: 'Reply with the single word: ok',
      maxTokens: 16, retry: { attempts: 1, baseMs: 1 }
    });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 300) };
  }
});
// Re-tint the native window controls when the renderer flips theme.
ipcMain.handle('titlebar:setTheme', (_e, mode) => {
  if (isMac || !win || win.isDestroyed() || !win.setTitleBarOverlay) return;
  win.setTitleBarOverlay(CHROME[mode] ?? CHROME.light);
});

// The custom title bar replaces the native menu; drop the default one.
Menu.setApplicationMenu(null);

// Auto-update via GitHub Releases (DESIGN-SPEC.md §9). Packaged builds only;
// dev runs skip this entirely. Failures are logged, never fatal.
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  import('electron-updater').then(({ autoUpdater }) => {
    autoUpdater.logger = console;
    autoUpdater.on('update-downloaded', () => {
      dialog.showMessageBox({
        type: 'info',
        title: 'Update ready',
        message: `A new version of ${APP_NAME} has been downloaded. Restart to apply it.`,
        buttons: ['Restart now', 'Later']
      }).then(({ response }) => { if (response === 0) autoUpdater.quitAndInstall(); });
    });
    autoUpdater.on('error', err => console.error('[auto-update]', err));
    autoUpdater.checkForUpdates().catch(err => console.error('[auto-update]', err));
  }).catch(err => console.error('[auto-update]', err));
}

app.whenReady().then(() => { createWindow(); setupAutoUpdate(); });
app.on('before-quit', () => {
  detachV2UiExtensions?.();
  detachV2UiExtensions = null;
  void v2HostPromise?.then(host => host?.booted.dispose());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
