import { app, BrowserWindow, ipcMain, shell, Menu, dialog, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FlowStore } from '../core/flowstore.js';
import { NodeStore } from '../core/nodestore.js';
import { ToolStore } from '../core/toolstore.js';
import { loadLibrary } from '../core/tools/index.js';
import { FlowRunner, normalizeApprovalMode, APPROVAL_MODES } from '../core/flowRunner.js';
import { pickSafetyModel, SAFETY_MODEL_CANDIDATES } from '../core/safetyCheck.js';
import { Workspace } from '../core/workspace.js';
import { ProjectRegistry, DEFAULT_PROJECT_ID } from '../core/projects.js';
import { lintFlow, lintText } from '../core/flowlang/lint.js';
import { resolveFlow, exposedFields, diffOverrides, setKnownTools } from '../src/flowTypes.js';
import { parseFlow } from '../core/flowlang/parse.js';
import { serializeFlow } from '../core/flowlang/serialize.js';
import { diffSnapshot } from '../core/snapshotDiff.js';
import { callsForNode } from '../core/runMetrics.js';
import { ensureIndex, readIndex, readIndexMeta, rebuildIndex, clearIndex } from '../core/metricsIndex.js';
import { filterRows, overview, rank, series, histogram, facets } from '../core/investigate.js';
import { listNodePresets, listFlowPresets, installNodePreset, installFlowPreset } from '../core/presets.js';
import { callModel, canServe } from '../core/adapters/index.js';
import {
  PROVIDER_IDS, KEYED_PROVIDERS, SUBSCRIPTION_PROVIDERS, DEFAULT_PRIORITY,
  CURATED_MODELS, TEST_MODELS, migrateSettings, createResolver,
  stampSeenModels, computeNewModelIds
} from '../core/modelSource.js';
import { MODEL_CATALOG, mergeModelRecords, bundledIdForOpenRouterId } from '../core/modelCatalog.js';
// Subscription (CLI-delegation) plumbing: sign-in detection + binary
// resolution. Presence checks only — no token is ever read (SUBSCRIPTION-AUTH-GUIDE).
import { claudeCredentialStatus, resolveClaudeCli } from '../core/adapters/claudeCode.js';
import { codexCredentialStatus, resolveCodexCli } from '../core/adapters/codexCli.js';
import { DRAFT_SYSTEM, buildDraftPrompt, parseDraft, credentialProblem } from '../core/toolDraft.js';
import { schemaProblems } from '../core/tools/schema.js';
import { checkTarget } from '../core/tools/net.js';
import { getProvider } from '../core/tools/providers.js';
import { APP_NAME, LOG_TAG, LEGACY_APP_DIRS } from '../core/brand.js';
import { migrateUserDataDir } from '../core/migrate.js';

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
// resolved against projectRoot in a packaged build.
const dataRoot = app.isPackaged ? app.getPath('userData') : projectRoot;

function dataDir(name) {
  const dir = path.join(dataRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// There used to be a seedFromBundle() here that copied flows/ out of the
// read-only app bundle into the writable data root on first launch. PIVOT-PLAN
// §5.1 removed the thing it existed for: nothing is installed on first launch
// any more. The bundled pipelines live in presets/ and are read in place
// (core/presets.js) — installing one is a deliberate click, which is exactly
// the property a first-run copy could never have.

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
// No longer seeded from the bundle: the flow store ships empty too (§5.1), and
// the packaged app carries presets/ instead of a flows/ directory to copy in.
const flows = new FlowStore(dataDir('flows'));
// PIVOT-PLAN §5.1 / decision 4: NOTHING is installed here any more. The library
// and the flow store both ship empty; the ten templates and five pipelines are
// PRESETS (presets/, core/presets.js), offered inside *Create node* and *Create
// flow*. The NodeStore still writes its KERNEL — the two or three system nodes
// the builder runs on — which is the floor beneath "no default nodes"
// (decision 3), hidden from every list the user sees.
const nodeLibrary = new NodeStore(dataDir('nodes'));

// --- Settings & secrets ---
// settings.json lives in userData (never the repo). Shape (PROVIDERS-PLAN §1):
//   { providers: { anthropic|openai|kimi|openrouter: { apiKey, keyKind? } },
//     providerPriority: [providerId, ...],              // auto-source walk order
//     activeModels: [{ id, source: 'auto'|providerId, enabled }],
//     workers: { executor: { provider, model } },
//     projectStorage: 'workspace' | 'appdata',        // T2a — where per-project files live
//     approvalMode: 'ask' | 'smart' | 'always',       // default tool-call gate for new runs
//     safetyModel: 'auto' | modelId,                  // classifier for 'smart' mode
//     projects: { open, active, recents, tabState } } // D22 — tab session (T17)
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return migrateSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
  catch { return migrateSettings({}); }
}
function persistSettings() {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

let settings = loadSettings();
persistSettings(); // seal the migration (legacy openrouterApiKey is gone after this)

// The tool library is files too (TOOLS-PLAN §4.1): tools/<id>.json seeds from
// the built-in modules, and the runtime registry is loaded FROM the files — so
// what a run can call is what the library says, not what happens to be
// imported. App-level like nodes/: capability is portable, expertise (skills,
// D15) is not. Loaded after settings, because a tool whose configuration is
// missing must be DISABLED WITH A REASON rather than failing mid-run.
const toolLibrary = new ToolStore(dataDir('tools'));

function loadToolLibrary() {
  const defs = toolLibrary.listFull().map(t =>
    t.id === 'web_search' && t.enabled && !settings.search?.apiKey
      ? { ...t, enabled: false, disabledReason: 'no web-search provider key is configured in Settings' }
      : t);
  const load = loadLibrary(defs, toolLibrary.listSets());
  // Template grants are filtered against the real library, here as well as in
  // the renderer: normalizeTemplate() drops unknown tool ids, and without this
  // it would drop every tool the built-ins don't happen to include.
  setKnownTools(load.loaded);
  for (const { id, reason } of load.skipped) console.warn(`${LOG_TAG} tool "${id}" not loaded: ${reason}`);
  for (const { file, error } of toolLibrary.problems) console.warn(`${LOG_TAG} tools/${file}: ${error}`);
  return load;
}
loadToolLibrary();

// A provider counts as connected when settings holds a key for it — or, for
// anthropic/openai, when the shell environment provides one (the adapters
// accept that fallback for CLI use). The mock provider is always connected.
function hasKey(provider) {
  if (provider === 'mock') return true;
  // Subscription providers connect via the vendor CLI's own sign-in, but only
  // once the user has explicitly opted in (the Settings card carries the
  // usage warning — Claude plan limits and Anthropic's OAuth terms).
  if (SUBSCRIPTION_PROVIDERS.includes(provider)) {
    const sub = settings.subscriptions?.[provider];
    if (!sub?.enabled) return false;
    return subscriptionStatus(provider).signedIn;
  }
  if (settings.providers?.[provider]?.apiKey) return true;
  if (provider === 'anthropic') return Boolean(process.env.ANTHROPIC_API_KEY);
  if (provider === 'openai') return Boolean(process.env.OPENAI_API_KEY);
  return false;
}

// Sign-in + CLI presence for one subscription provider (cheap fs checks).
function subscriptionStatus(provider) {
  const sub = settings.subscriptions?.[provider] ?? {};
  const home = sub.home || null;
  if (provider === 'claude-code') {
    return { ...claudeCredentialStatus(home), cli: resolveClaudeCli(sub.cliPath || null) };
  }
  return { ...codexCredentialStatus(home), cli: resolveCodexCli(sub.cliPath || null) };
}

// The resolution rule (PROVIDERS-PLAN §2). Pinned source wins when it has a
// key; 'auto' walks providerPriority, skipping disconnected providers and
// providers that can't serve the id. Returns the fully-stamped call target —
// { provider, model, apiKey, keyKind? } — ready to hand to callModel.
const resolveSource = createResolver({ hasKey, canServe, priority: () => settings.providerPriority });
function resolveModelSource(modelId, pinned = null) {
  const entry = (settings.activeModels ?? []).find(m => m.id === modelId);
  const source = pinned ?? entry?.source ?? 'auto';
  const r = resolveSource(modelId, source);
  const out = {
    ...r,
    apiKey: settings.providers?.[r.provider]?.apiKey ?? null,
    ...(r.provider === 'kimi' ? { keyKind: settings.providers?.kimi?.keyKind ?? 'platform' } : {})
  };
  // Subscription targets carry their optional overrides to the adapter:
  // cliHome selects the account (credential dir), cliPath the binary. No key.
  if (SUBSCRIPTION_PROVIDERS.includes(r.provider)) {
    const sub = settings.subscriptions?.[r.provider];
    if (sub?.home) out.cliHome = sub.home;
    if (sub?.cliPath) out.cliPath = sub.cliPath;
  }
  return out;
}

// Runtime config = config.json defaults merged with settings.json overrides,
// with each worker's provider key injected. Rebuilt in place on every settings
// save so the running Pipeline picks up changes without a restart (Pipeline
// holds a reference to this object).
const runtimeConfig = { ...baseConfig };

function rebuildRuntimeConfig() {
  const workers = {};
  for (const [name, def] of Object.entries(baseConfig.workers)) {
    const override = settings.workers?.[name];
    let w = override?.provider && override?.model
      ? { provider: override.provider, model: override.model }
      : { provider: def.provider, model: def.model };
    // A model the user activated is resolved through the providers map: its
    // pinned source (or the priority walk for 'auto') decides who serves it,
    // and the key rides along (PROVIDERS-PLAN §4). A model the registry doesn't
    // know keeps the legacy behavior — worker's own provider + key injection.
    const entry = (settings.activeModels ?? []).find(m => m.id === w.model);
    if ((entry && entry.enabled !== false) || w.provider === 'auto') {
      try {
        const r = resolveModelSource(w.model, entry ? undefined : 'auto');
        w = { provider: r.provider, model: r.model, apiKey: r.apiKey, ...(r.keyKind ? { keyKind: r.keyKind } : {}) };
      } catch { /* unresolved: the call fails with the adapter's missing-key error */ }
    }
    if (!w.apiKey && settings.providers?.[w.provider]?.apiKey) {
      w.apiKey = settings.providers[w.provider].apiKey;
    }
    if (w.provider === 'kimi' && !w.keyKind) w.keyKind = settings.providers?.kimi?.keyKind ?? 'platform';
    // Native tool-calling capability, learned from model catalogs (persisted
    // in settings.json). Unknown models fall back to the text tool protocol,
    // which works everywhere.
    if (w.provider !== 'mock' && w.provider !== 'anthropic') {
      w.supportsTools = Boolean(settings.modelCapabilities?.[w.model]);
    }
    workers[name] = w;
  }
  runtimeConfig.workers = workers;
  // Per-provider key lookup for task workers persisted in runs/tasks.json,
  // which must never contain the key itself.
  runtimeConfig.providerKeys = Object.fromEntries(
    KEYED_PROVIDERS.filter(p => settings.providers?.[p]?.apiKey).map(p => [p, settings.providers[p].apiKey])
  );
  // Connected subscription providers join the map with a sentinel — the
  // default-worker picker treats presence as "connected", and the adapters
  // ignore apiKey by design (the CLI owns auth).
  for (const p of SUBSCRIPTION_PROVIDERS) {
    if (hasKey(p)) runtimeConfig.providerKeys[p] = 'subscription';
  }
  // Call-time resolution for 'auto' workers (active-models picks ride on nodes
  // and tasks as { provider: 'auto', model }).
  runtimeConfig.resolveModelSource = resolveModelSource;
  // Which Kimi endpoint the saved key belongs to — the model-priority defaults
  // (core/modelPriority.js) pick kimi-for-coding for a Kimi-Code key.
  runtimeConfig.kimiKeyKind = settings.providers?.kimi?.keyKind ?? 'platform';
  // Per-model tool support for task workers resolved at execution time.
  runtimeConfig.modelCapabilities = settings.modelCapabilities ?? {};
  // The mock provider's authoring state (G8/§6): resolveCallTarget stamps it
  // onto mock call targets, and core/adapters/mock.js branches on its mode.
  runtimeConfig.mock = settings.mock ?? null;
  // Web-search provider for the web_search tool (TOOLS-PLAN §14.3). The key
  // lives in settings and reaches the tool through ctx at call time — never
  // through a tool definition, and never into the model's context (§10.3).
  runtimeConfig.search = settings.search?.apiKey
    ? { provider: settings.search.provider ?? 'brave', apiKey: settings.search.apiKey }
    : null;
  // Category → worker mapping for advanced planning flows (FLOW_NODES.md)
  runtimeConfig.categoryWorkers = baseConfig.categoryWorkers ?? {};
  // Default tool-call approval mode for runs started without an explicit one.
  // 'ask' is the shipped default: an agent with a shell should not run
  // unattended because nobody got round to choosing.
  runtimeConfig.approvalMode = normalizeApprovalMode(settings.approvalMode ?? 'ask');
  // PIVOT-PLAN §4.4: the price table the call ledger costs against. Built from
  // the MERGED catalog, so live OpenRouter pricing is used where the bundled
  // file is stale and aggregator-only routes are priceable at all. A model
  // missing from here yields `estimated: true`, never a fabricated zero.
  runtimeConfig.modelPrices = Object.fromEntries(
    publicCatalog().filter(m => m.price).map(m => [m.id, m.price])
  );
  // §4.3: wire capture. 'bounded' is the shipped default — redacted, capped at
  // 256 KB per body. 'full' is opt-in because whole bodies are megabytes and
  // runs accumulate forever; 'off' for anyone who'd rather not have prompts on
  // disk at all.
  runtimeConfig.wireCapture = ['off', 'bounded', 'full'].includes(settings.wireCapture)
    ? settings.wireCapture : 'bounded';
  // §5.2: the per-attempt timeout that finally fires the AbortSignal threaded
  // everywhere by RUN-CONTROL. 0 disables it.
  runtimeConfig.timeoutMs = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 600_000;
  // What 'smart' mode screens with. The runner gets a resolver, never a key —
  // same contract as resolveModelSource above.
  runtimeConfig.safety = {
    model: effectiveSafetyModel(),
    resolveModelSource
  };
}

// The classifier 'smart' mode actually uses: the user's pin, or — for 'auto' —
// the cheapest candidate whose provider has a key (core/safetyCheck.js keeps
// the ranked list). Null when no provider is connected at all, which
// checkToolCall reports as 'caution' and the gate turns into a normal ask.
function effectiveSafetyModel() {
  return pickSafetyModel(settings.safetyModel ?? 'auto', hasKey);
}
rebuildRuntimeConfig();

// --- Catalog state (SETTINGS-MODELS-PLAN §2/§3) -------------------------------

// Every model id this install knows about: the bundled catalog plus the cached
// OpenRouter fetch. The NEW diff runs over both, so a provider shipping a
// model legitimately surfaces as NEW on the next read.
function knownCatalogIds() {
  const ids = MODEL_CATALOG.map(m => m.id);
  for (const m of settings.modelCatalogCache?.openrouter?.models ?? []) ids.push(m.id);
  return ids;
}

// Stamp newly discovered ids into the seen-ledger (main-side only, §3). Runs
// on settings:get and on catalog fetch; persists only when something changed.
function refreshSeenModels() {
  const r = stampSeenModels(knownCatalogIds(), settings.seenModels, settings.acknowledgedModels);
  if (r.changed) {
    settings.seenModels = r.seenModels;
    settings.acknowledgedModels = r.acknowledgedModels;
    persistSettings();
  }
}

// The merged catalog the renderer sees (§3): bundled records with live
// OpenRouter price/context folded in where the ids map (bundled wins
// name/tier/training, live wins price/contextLength), then the
// aggregator-only routes appended with an honest 'unknown' training policy.
function publicCatalog() {
  const cached = settings.modelCatalogCache?.openrouter?.models ?? [];
  const liveByBundled = {};
  for (const m of cached) {
    const b = bundledIdForOpenRouterId(m.id);
    if (b && !liveByBundled[b]) liveByBundled[b] = m;
  }
  const bundled = MODEL_CATALOG.filter(m => !m.aliasOf).map(rec => {
    const live = liveByBundled[rec.id];
    return mergeModelRecords(rec,
      live ? { price: live.price ?? null, contextLength: live.contextLength ?? null, releasedAt: live.releasedAt ?? null } : null);
  });
  const extras = cached.filter(m => !bundledIdForOpenRouterId(m.id)).map(m => ({
    id: m.id, name: m.name, providers: ['openrouter'],
    family: String(m.id).split('/')[0], tier: null,
    releasedAt: m.releasedAt ?? null, contextLength: m.contextLength ?? null, maxOutput: null,
    price: m.price ?? null,
    caps: { tools: Boolean(m.supportsTools) },
    training: { policy: 'unknown', scope: 'aggregator', note: '', source: null },
    deprecated: false, aliasOf: null
  }));
  return [...bundled, ...extras];
}

// What the renderer is allowed to see: per-provider hasKey flags (never the
// keys), the priority order, the active-model registry, worker assignments,
// and a small connected/model-count summary for the overview UI.
function publicSettings() {
  const providers = Object.fromEntries(PROVIDER_IDS.map(p => {
    const entry = {
      hasKey: hasKey(p),
      ...(p === 'kimi' ? { keyKind: settings.providers?.kimi?.keyKind ?? 'platform' } : {})
    };
    // Subscription card state: opted in? signed in? CLI found? Paths shown are
    // locations, never contents — the renderer needs them to say "run
    // `codex login`" vs "enable it" vs "install the CLI" precisely.
    if (SUBSCRIPTION_PROVIDERS.includes(p)) {
      const sub = settings.subscriptions?.[p] ?? {};
      const st = subscriptionStatus(p);
      entry.subscription = {
        enabled: Boolean(sub.enabled),
        signedIn: st.signedIn,
        credentialPath: st.detail,
        cliFound: Boolean(st.cli),
        cliCommand: st.cli ? [st.cli.command, ...st.cli.args].join(' ') : null,
        home: sub.home ?? '',
        cliPath: sub.cliPath ?? ''
      };
    }
    return [p, entry];
  }));
  const activeModels = settings.activeModels ?? [];
  const connectable = [...KEYED_PROVIDERS, ...SUBSCRIPTION_PROVIDERS];
  return {
    providers,
    // Legacy flag for the lander's no-key hint: any provider at all.
    hasKey: connectable.some(hasKey),
    // The lander's usage notice: runs may draw on the Claude subscription.
    claudeSubscriptionActive: hasKey('claude-code'),
    providerPriority: settings.providerPriority ?? [...DEFAULT_PRIORITY],
    activeModels,
    workers: Object.fromEntries(
      Object.entries(runtimeConfig.workers).map(([name, w]) => [name, { provider: w.provider, model: w.model }])
    ),
    summary: {
      connected: connectable.filter(hasKey).length,
      activeModelCount: activeModels.filter(m => m.enabled !== false).length
    },
    // T2a: where per-project files are written ('workspace' = in-repo .flyt/,
    // 'appdata' = under userData). Read at project-open time.
    projectStorage: settings.projectStorage === 'appdata' ? 'appdata' : 'workspace',
    // Tool-call approval (APPROVAL-MODES): the default new runs start under,
    // the classifier 'smart' mode screens with, and enough about the candidate
    // list for Settings to render pickers without duplicating the ranking.
    approvalMode: normalizeApprovalMode(settings.approvalMode ?? 'ask'),
    safetyModel: settings.safetyModel ?? 'auto',
    resolvedSafetyModel: effectiveSafetyModel(),
    // P3: the comparison judge's pinned model ('' = the default worker).
    judgeModel: settings.judgeModel ?? '',
    // Web search (TOOLS-PLAN §14.3): whether the web_search tool is configured,
    // never the key itself. Absent a key the tool is disabled with that reason
    // showing in the library rather than failing in the middle of a run.
    search: { provider: settings.search?.provider ?? 'brave', hasKey: Boolean(settings.search?.apiKey) },
    safetyCandidates: SAFETY_MODEL_CANDIDATES.map(c => ({
      ...c, connected: [c.provider, ...(c.altProviders ?? [])].some(hasKey)
    })),
    // SETTINGS-MODELS-PLAN §3: the merged catalog and the user's overlay state
    // over it. newModelIds is computed main-side; the renderer never diffs.
    catalog: publicCatalog(),
    favouriteModels: settings.favouriteModels ?? [],
    newModelIds: computeNewModelIds(knownCatalogIds(), settings.seenModels, settings.acknowledgedModels),
    modelGrouping: settings.modelGrouping ?? 'provider',
    showAllModels: settings.showAllModels === true,
    mock: settings.mock ?? {
      enabled: false, mode: 'roles', customResponse: '', perRole: {},
      latencyMs: 700, streaming: true, failureRate: 0
    },
    // PIVOT-PLAN §4.3 / §5.2: the call ledger's two knobs.
    wireCapture: ['off', 'bounded', 'full'].includes(settings.wireCapture) ? settings.wireCapture : 'bounded',
    timeoutMs: Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 600_000
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
  defaultRunsDir: path.join(dataRoot, 'runs'),
  appDataDir: app.getPath('userData'),
  // T2a: the storage location is a Settings choice, read at project-open time.
  getStorage: () => (settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'),
  createRunner: (store, projectId) => {
    const runner = new FlowRunner(store, runtimeConfig, pushUpdateFor(projectId), nodeLibrary);
    // Nothing is live when a project first opens in this process, so any run
    // still in a non-terminal stage was cut off by the app dying. Flag those
    // once so the run view can offer Resume (V1 task 7).
    const interrupted = runner.reconcileInterrupted();
    if (interrupted.length) console.log(`${LOG_TAG} ${projectId}: ${interrupted.length} interrupted run(s) marked resumable`);
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

// One engine, one entry point: pick a workflow, type a request, run it.
// The user input becomes the flow's User Input node content for that run.
// approvalMode rides in from the chatbox picker (APPROVAL-MODES §3): the mode
// shown beside the Run button is the mode the run is captured under, so what
// the user saw when they pressed Run is what governs it for its whole life.
// Omitted (or unrecognized) falls back to the saved default.
ipcMain.handle('flow:run', (_e, projectId, flowId, userInput = '', workspaceDir = null, approvalMode = null, launch = null) => {
  const entry = proj(projectId);
  // Bind the target workspace at run time (D15): validate the folder, create
  // its .flyt/ config dir, and pass the confined absolute root to the runner
  // so it lands in meta.json. A bound tab IS the workspace — its runs always
  // target the tab's folder (T19); only the unbound scratch tab still picks a
  // workspace per run (or none — mock/no-file flows run without one).
  let workspace = null;
  if (entry.folder) workspace = new Workspace(entry.folder).ensure().root;
  // An appdata project (L5) has its own managed workspace/ dir inside its
  // appData home (Q-L5); runs there always bind to it, like a bound tab.
  else if (entry.kind === 'appdata') workspace = new Workspace(entry.workspaceRoot).ensure().root;
  else if (workspaceDir) workspace = new Workspace(workspaceDir).ensure().root;
  // launch (MODES-COMPARE) carries the picked mode and any exposed run-input
  // overrides: { modeId?, overrides? }. Absent = an ordinary default-mode run.
  return entry.runner.start(flows.load(flowId), {
    userInput: String(userInput ?? ''),
    workspace,
    approvalMode: APPROVAL_MODES.includes(approvalMode) ? approvalMode : runtimeConfig.approvalMode,
    modeId: launch?.modeId ?? null,
    overrides: launch?.overrides ?? null,
    // Compare launches (CONFIGS-COMPARE P2) stamp both runs with the shared
    // group id + A/B label; the record itself lands via compare:save.
    compareGroup: launch?.compareGroup ?? null
  });
});
ipcMain.handle('run:approve', (_e, projectId, runId) => proj(projectId).runner.approvePlan(runId));
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
ipcMain.handle('run:reject', (_e, projectId, runId, reason) => proj(projectId).runner.rejectPlan(runId, reason));
// Continue a run the app died in the middle of. Completed nodes are kept and
// not re-executed (V1 task 7). RUN-CONTROL: also releases a soft-paused run —
// the runner resolves the pause gate and the walk clears meta.paused itself.
ipcMain.handle('run:resume', (_e, projectId, runId) => proj(projectId).runner.resume(runId));
// Hard stop a live run (RUN-CONTROL): aborts in-flight model calls, settles
// any pending approval/pause gate, marks the run 'cancelled' with cancelledAt,
// and frees the live registry — which is what unblocks run:delete below.
ipcMain.handle('run:stop', (_e, projectId, runId) => proj(projectId).runner.stop(runId));
// Soft pause (RUN-CONTROL): the run holds at the next wave boundary — the wave
// in flight always settles first. meta.paused flips true only once the hold
// has actually landed; run:resume releases it.
ipcMain.handle('run:pause', (_e, projectId, runId) => proj(projectId).runner.pause(runId));
// Re-run one node and everything downstream of it (RUN-CONTROL), with optional
// guidance injected into the retry prompt. Only on a non-live run.
ipcMain.handle('run:restartNode', (_e, projectId, runId, nodeId, guidance = '') =>
  proj(projectId).runner.restartNode(runId, nodeId, String(guidance ?? '')));
// Fork a finished run at a node (RUN-CONTROL): upstream outputs are preserved
// as context, downstream nodes re-run in the copy.
ipcMain.handle('run:branch', (_e, projectId, runId, nodeId) => proj(projectId).runner.branch(runId, nodeId));
// Plain-language status read on one node (RUN-CONTROL): status, (partial)
// output, retrospective, log tail, and a model-written summary.
ipcMain.handle('run:investigateNode', (_e, projectId, runId, nodeId) =>
  proj(projectId).runner.investigateNode(runId, nodeId));
// Summary nodes (OUTPUT-VIEW-PLAN B4): summarize one or more node outputs into
// a run artifact (summaries/<key>.md + index.json); delete removes both; move
// persists a dragged card's canvas position.
ipcMain.handle('run:summarize', (_e, projectId, runId, sourceIds, position = null) =>
  proj(projectId).runner.summarizeOutputs(runId, sourceIds, { position }));
ipcMain.handle('run:deleteSummary', (_e, projectId, runId, summaryId) =>
  proj(projectId).runner.deleteSummary(runId, summaryId));
ipcMain.handle('run:moveSummary', (_e, projectId, runId, summaryId, position) =>
  proj(projectId).runner.moveSummary(runId, summaryId, position));
// Reply to a finished run (FOLLOWUP-PLAN): the flow grows with a continuation
// subgraph and the walk executes it; completed nodes are never re-run.
ipcMain.handle('run:followUp', (_e, projectId, runId, text) => proj(projectId).runner.followUp(runId, String(text ?? '')));
// Answer a run parked at the refiner's awaiting_input gate (MODES-COMPARE T6).
// Distinct from run:followUp — this closes an in-flight question and re-runs
// the refine node with the answer; it does not open a new follow-up turn.
ipcMain.handle('run:answerInput', (_e, projectId, runId, text) => proj(projectId).runner.answerInput(runId, String(text ?? '')));
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
  entry.store.deleteComparisonsFor(runId); // P2: pairings naming the run go with it
  pushStateFor(entry.id).channels.delete(runId); // drop the patch baseline; the id is gone for good
  return true;
});

// --- Comparison records (CONFIGS-COMPARE P2) ---
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
ipcMain.handle('run:snapshot', (_e, projectId, runId) => {
  const entry = proj(projectId);
  const chans = pushStateFor(entry.id).channels;
  const snapshot = entry.store.snapshot(runId);
  const rev = (chans.get(runId)?.rev ?? 0) + 1;
  chans.set(runId, { snapshot, rev });
  return { ...snapshot, rev };
});
ipcMain.handle('run:openFolder', (_e, projectId, runId) => shell.openPath(proj(projectId).store.runDir(runId)));
// Open one file inside a run — today the tool-result artifacts the inspector
// links (TOOLS-PLAN §13). The path comes from the renderer, so it is resolved
// against the run directory and rejected if it escapes: a relative path from
// a record is data, and data does not get to name a file outside the run.
ipcMain.handle('run:openArtifact', (_e, projectId, runId, relPath) => {
  const dir = path.resolve(proj(projectId).store.runDir(runId));
  const target = path.resolve(dir, String(relPath ?? ''));
  if (target !== dir && !target.startsWith(dir + path.sep)) throw new Error('Path escapes the run directory');
  if (!fs.existsSync(target)) throw new Error('No such file in this run');
  return shell.openPath(target);
});
ipcMain.handle('run:log', (_e, projectId, runId) => proj(projectId).store.readLog(runId));

// --- The call ledger (PIVOT-PLAN §6.1) ---------------------------------------
// The per-attempt list for a node, and the wire record for one call. The
// snapshot already carries the FOLDED metrics; these two are what the Calls tab
// and the wire viewer open on demand, because whole request bodies have no
// business riding on every live push.
ipcMain.handle('run:calls', (_e, projectId, runId, nodeId = null, taskId = null) => {
  const calls = proj(projectId).store.readCalls(runId);
  return (nodeId || taskId) ? callsForNode(calls, nodeId, taskId) : calls.map(({ rawUsage, ...c }) => c);
});
// Returns the record plus both wire bodies as TEXT — already redacted and
// bounded when they were written, so there is nothing left to sanitise here.
ipcMain.handle('run:callWire', (_e, projectId, runId, seq) => {
  const store = proj(projectId).store;
  const n = Number(seq);
  const record = store.readCalls(runId).find(c => c.seq === n) ?? null;
  if (!record) return { ok: false, error: 'No such call in this run.' };
  return {
    ok: true,
    record,
    request: store.readCallWire(runId, n, 'request'),
    response: store.readCallWire(runId, n, 'response')
  };
});

// --- The Investigator page (PIVOT-PLAN §6.2) ---------------------------------
// One handler, because the three views are three folds of the same rows and
// splitting them would mean scanning the index three times for one screen.
// The index is rebuilt here whenever it is stale — silently, per §4.5 — so
// deleting runs/_index/ is always safe and never something the user has to
// know about.
ipcMain.handle('metrics:query', (_e, projectId, filters = {}) => {
  const store = proj(projectId).store;
  ensureIndex(store);
  const all = readIndex(store);
  const rows = filterRows(all, filters);
  return {
    ok: true,
    index: readIndexMeta(store),
    // The unfiltered totals, so the page can say "showing 240 of 1,904 calls"
    // rather than implying the filtered view is everything there is.
    total: all.length,
    overview: overview(rows),
    leaderboard: rank(rows, { by: filters.by ?? 'model' }),
    spend: series(rows, { bucket: filters.bucket ?? 'day' }),
    latency: histogram(rows.filter(r => r.ok).map(r => r.durationMs)),
    throughput: histogram(rows.filter(r => r.ok).map(r => r.tps)),
    facets: {
      model: facets(all, 'model'),
      provider: facets(all, 'provider'),
      role: facets(all, 'role'),
      flowId: facets(all, 'flowId')
    }
  };
});
// Verification item 7 made reachable from the UI: delete the index, prove every
// number comes back the same.
ipcMain.handle('metrics:rebuild', (_e, projectId) => {
  const store = proj(projectId).store;
  clearIndex(store);
  return { ok: true, index: rebuildIndex(store) };
});

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
  pushState.delete(oldId); // the old id is gone for good — drop its push channels
  updateWindowTitle();
  return { ...projectListPayload(), oldId, opened: newId };
});
// Reveal a tab's project directory in the OS file manager (folder tabs open the
// bound workspace; appdata tabs open their app-managed dir). The path comes from
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
ipcMain.handle('config:get', () => ({ workers: publicSettings().workers }));

// --- Flow definitions (editable workflow graphs) ---
ipcMain.handle('flow:list', () => flows.list());
ipcMain.handle('flow:load', (_e, id) => flows.load(id));
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
ipcMain.handle('flow:lint', (_e, id) =>
  lintFlow(flows.load(id), { templates: nodeLibrary.listFull(), library: toolLibrary.catalog() }));

// --- Configs (CONFIGS-COMPARE P1): modes as first-class bundles ---
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

// The exposed run inputs (MODES-COMPARE T10) of a flow: which node fields the
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
    return out;
  } catch { return []; }
});

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
  lintText(yamlText, { templates: nodeLibrary.listFull(), library: toolLibrary.catalog() }));

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

// --- Presets (PIVOT-PLAN §5.1, decision 4) -----------------------------------
// The second of the three doors out of an empty library: Blank · Start from a
// preset · Describe it. `installed` marks presets already in the library, so
// the gallery can say "you have this" instead of failing on the click.
ipcMain.handle('preset:list', () => {
  const have = new Set(nodeLibrary.listFull().map(t => t.id));
  const haveFlows = new Set(flows.list().map(f => f.id));
  return {
    nodes: listNodePresets().map(p => ({
      id: p.presetId, name: p.name, description: p.description, icon: p.icon,
      category: p.category, baseType: p.baseType, role: p.role,
      installed: have.has(p.presetId)
    })),
    flows: listFlowPresets().map(p => ({
      id: p.presetId, name: p.name, description: p.description,
      nodeCount: p.nodeCount, needs: p.needs,
      // Which templates this preset would ALSO install. The dialog says so
      // before the click: a flow quietly adding three templates to your library
      // is exactly the behaviour the empty library exists to end.
      willInstall: p.needs.filter(n => !have.has(n)),
      installed: haveFlows.has(p.presetId)
    }))
  };
});
ipcMain.handle('preset:installNode', (_e, presetId, asId = null) => {
  try { return { ok: true, template: installNodePreset(nodeLibrary, presetId, { asId }) }; }
  catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
});
ipcMain.handle('preset:installFlow', (_e, presetId, asId = null) => {
  try { return { ok: true, ...installFlowPreset(flows, nodeLibrary, presetId, { asId }) }; }
  catch (err) { return { ok: false, error: String(err?.message ?? err) }; }
});

// --- Tool Library (tools/<id>.json) ---
// Read for the grant pickers, write for the Tools page. `tool:board` is the
// one call the page opens with: tools, categories and the read problems in a
// single round trip, so the board paints once instead of three times.
ipcMain.handle('tool:list', () => toolLibrary.list());
ipcMain.handle('tool:folder', () => ({ dir: toolLibrary.rootDir, packaged: app.isPackaged }));
ipcMain.handle('tool:board', () => {
  const tools = toolLibrary.list();
  const categories = toolLibrary.listCategories();
  return { tools, categories, problems: toolLibrary.problems };
});
// Every write reloads the runtime registry. Without this a tool authored on
// the Tools page would exist as a file but not be callable until the next
// launch — the library and what a run can actually reach would disagree, which
// is the exact confusion "a tool is a file" exists to remove.
const savedTool = value => { loadToolLibrary(); return value; };
ipcMain.handle('tool:save', (_e, def) => savedTool(toolLibrary.save(def)));
ipcMain.handle('tool:delete', (_e, id) => savedTool(toolLibrary.remove(id)));
ipcMain.handle('tool:setEnabled', (_e, id, enabled) => savedTool(toolLibrary.setEnabled(id, enabled)));
// Drag-to-recategorize. One field, so a stale card in the renderer can't
// round-trip a whole definition over the top of the file that owns it.
ipcMain.handle('tool:setCategory', (_e, id, categoryId) => toolLibrary.setCategory(id, categoryId));
ipcMain.handle('tool:saveCategory', (_e, def) => toolLibrary.saveCategory(def));
ipcMain.handle('tool:deleteCategory', (_e, id) => toolLibrary.removeCategory(id));
ipcMain.handle('tool:reorderCategories', (_e, ids) => toolLibrary.reorderCategories(ids));

// The wizard's "Run preflight". Deliberately NOT a live request: the `http`
// provider lands in P5, so a button that claimed to have called the endpoint
// would be theatre. What it does instead is real and is most of the value —
// it validates the schema through the same validator the registry uses, and
// runs the URL through the §10.2 network policy (checkTarget), which is the
// check that actually refuses a tool at run time. A tool that passes preflight
// is a tool that will load; whether the endpoint answers is P5's question.
ipcMain.handle('tool:preflight', async (_e, def = {}) => {
  const checks = [];
  const problems = schemaProblems(def.parameters);
  checks.push(problems.length
    ? { ok: false, label: 'parameters', detail: problems.join('; ') }
    : { ok: true, label: 'parameters', detail: `${Object.keys(def.parameters?.properties ?? {}).length} validated` });

  const url = def?.http?.url ?? null;
  if (url) {
    // Strip the templating before the policy sees it: {{city}} and
    // ${secrets.KEY} are not part of the host, and leaving them in would make
    // every templated URL fail to parse rather than fail honestly.
    const probe = String(url).replace(/\$\{secrets\.[A-Za-z0-9_]+\}/g, 'x').replace(/\{\{[^}]*\}\}/g, 'x');
    try {
      const verdict = await checkTarget(probe, { allowPrivate: def.http?.allowPrivate === true, allowedHosts: def.http?.allowedHosts ?? null });
      checks.push(verdict.ok
        ? { ok: true, label: 'network policy', detail: `${verdict.hostname} → ${verdict.address}` }
        : { ok: false, label: 'network policy', detail: verdict.reason });
    } catch (err) {
      checks.push({ ok: false, label: 'network policy', detail: String(err?.message ?? err) });
    }
  }

  const bad = credentialProblem(def);
  checks.push(bad
    ? { ok: false, label: 'secrets', detail: bad }
    : { ok: true, label: 'secrets', detail: 'no literal credentials in the definition' });

  if (def.provider && def.provider !== 'builtin') {
    const provider = getProvider(def.provider);
    let detail = `provider "${def.provider}" is unknown`;
    let ok = false;
    if (provider) {
      try { provider.load(def); ok = true; detail = `${def.provider} provider ready`; }
      catch (err) { detail = String(err?.message ?? err); }
    }
    // A provider that has not shipped is a WARNING, not a failure: the
    // definition is still correct and still worth saving.
    checks.push({ ok, warn: !ok, label: 'provider', detail });
  }

  return { ok: checks.every(c => c.ok || c.warn), checks };
});

// The Tool copilot: one direct model call, outside any run — the same shape as
// the comparison judge and the Settings provider test. core/toolDraft.js owns
// the contract and the parse; this owns only the round trip. It returns a
// DRAFT, never a file: saving is `tool:save`, which the user triggers.
ipcMain.handle('tool:draft', async (_e, { brief, modelId, attachment, history } = {}) => {
  try {
    const target = resolveModelSource(modelId || (settings.activeModels ?? [])[0]?.id || 'mock-large');
    const prompt = buildDraftPrompt({
      brief,
      attachment,
      history: Array.isArray(history) ? history : [],
      categories: toolLibrary.listCategories(),
      existingIds: toolLibrary.listFull().map(t => t.id)
    });
    const res = await callModel({
      ...target,
      system: DRAFT_SYSTEM,
      prompt,
      maxTokens: 3000
    });
    const text = typeof res === 'string' ? res : (res?.text ?? res?.content ?? '');
    return { ok: true, model: target.model, ...parseDraft(text) };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err).slice(0, 400) };
  }
});

ipcMain.handle('settings:get', () => {
  refreshSeenModels();
  return publicSettings();
});

// G4: the NEW badge clears when the user expands the group containing it —
// an explicit acknowledgement, persisted so it survives restarts. The badge
// would expire on its own 21-day clock regardless (computeNewModelIds).
ipcMain.handle('settings:markSeen', (_e, ids) => {
  const list = (Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.trim());
  if (list.length) {
    const ack = new Set(settings.acknowledgedModels ?? []);
    for (const id of list) ack.add(id.trim());
    settings.acknowledgedModels = [...ack];
    persistSettings();
  }
  return publicSettings();
});

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
  // Web-search provider for the web_search tool (TOOLS-PLAN §14.3). One-way
  // like a provider key: a non-empty string sets it, the literal null clears
  // it, and anything else leaves it alone — so saving other settings can never
  // wipe the key. The key itself is never returned to the renderer.
  if (patch.search && typeof patch.search === 'object') {
    const key = patch.search.apiKey;
    if (key === null) delete settings.search;
    else if (typeof key === 'string' && key.trim()) {
      settings.search = {
        provider: typeof patch.search.provider === 'string' && patch.search.provider.trim()
          ? patch.search.provider.trim() : (settings.search?.provider ?? 'brave'),
        apiKey: key.trim()
      };
    } else if (typeof patch.search.provider === 'string' && settings.search) {
      settings.search = { ...settings.search, provider: patch.search.provider.trim() };
    }
  }
  // Subscription opt-ins (SUBSCRIPTION-AUTH-GUIDE): per provider —
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
        enabled: m.enabled !== false
      }));
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
  // The comparison judge's model (CONFIGS-COMPARE P3): an explicit model id,
  // or '' to clear back to the default worker. Same free-id rule as the
  // safety model — resolved at call time, so an unrouted id fails then, not here.
  if (typeof patch.judgeModel === 'string') {
    const v = patch.judgeModel.trim();
    if (v) settings.judgeModel = v; else delete settings.judgeModel;
  }
  // Catalog overlay state (SETTINGS-MODELS-PLAN §3): favourites are an ordered
  // deduped id list; grouping/show-all are plain validated scalars; mock is a
  // partial merge over the §3 defaults, same field rules as migrateSettings.
  if (Array.isArray(patch.favouriteModels)) {
    settings.favouriteModels = [...new Set(patch.favouriteModels
      .filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  }
  if (['provider', 'tier', 'cost'].includes(patch.modelGrouping)) {
    settings.modelGrouping = patch.modelGrouping;
  }
  if (typeof patch.showAllModels === 'boolean') {
    settings.showAllModels = patch.showAllModels;
  }
  // PIVOT-PLAN §4.3 / §5.2 — the two knobs the call ledger exposes.
  //
  // Wire capture is the one setting in the app with a real data-loss dimension:
  // 'full' keeps whole request bodies, which means source code and anything
  // pasted into a prompt, uncapped, on disk, forever. It is opt-in for that
  // reason and 'bounded' ships as the default.
  if (['off', 'bounded', 'full'].includes(patch.wireCapture)) {
    settings.wireCapture = patch.wireCapture;
  }
  // 0 disables the per-attempt timeout, which is the pre-pivot behaviour and
  // stays reachable on purpose for slow local models.
  if (Number.isFinite(patch.timeoutMs) && patch.timeoutMs >= 0) {
    settings.timeoutMs = Math.min(Math.trunc(patch.timeoutMs), 3_600_000);
  }
  if (patch.mock && typeof patch.mock === 'object') {
    const inc = patch.mock;
    const next = {
      enabled: false, mode: 'roles', customResponse: '', perRole: {},
      latencyMs: 700, streaming: true, failureRate: 0,
      ...(settings.mock ?? {})
    };
    if (typeof inc.enabled === 'boolean') next.enabled = inc.enabled;
    if (['roles', 'custom', 'echo', 'error'].includes(inc.mode)) next.mode = inc.mode;
    if (typeof inc.customResponse === 'string') next.customResponse = inc.customResponse;
    if (inc.perRole && typeof inc.perRole === 'object') {
      const perRole = {};
      for (const [role, text] of Object.entries(inc.perRole)) {
        if (typeof role === 'string' && role.trim() && typeof text === 'string') perRole[role] = text;
      }
      next.perRole = perRole;
    }
    if (Number.isFinite(inc.latencyMs) && inc.latencyMs >= 0) next.latencyMs = Math.min(inc.latencyMs, 60_000);
    if (typeof inc.streaming === 'boolean') next.streaming = inc.streaming;
    if (Number.isFinite(inc.failureRate)) next.failureRate = Math.min(Math.max(inc.failureRate, 0), 1);
    settings.mock = next;
  }
  persistSettings();
  rebuildRuntimeConfig();
  // A tool can be disabled for want of configuration (web_search without a
  // search key), so the library is re-read when settings change: adding the
  // key must not require a restart to make the tool appear.
  loadToolLibrary();
  return publicSettings();
});

// Per-provider model catalogs (PROVIDERS-PLAN §4): openrouter keeps its live
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
  const models = (data.data ?? []).map(m => {
    // OpenRouter reports USD PER TOKEN in `pricing`; the catalog's unit is USD
    // per 1M tokens (SETTINGS-MODELS-PLAN §2). `created` (unix seconds) is the
    // release signal that feeds releasedAt and, downstream, the NEW diff.
    const price = m.pricing ? {
      input: m.pricing.prompt != null ? Number(m.pricing.prompt) * 1e6 : null,
      output: m.pricing.completion != null ? Number(m.pricing.completion) * 1e6 : null
    } : null;
    return {
      id: m.id,
      name: m.name ?? m.id,
      contextLength: m.context_length ?? null,
      supportsTools: (m.supported_parameters || []).includes('tools'),
      price,
      releasedAt: m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : null
    };
  });
  // Remember which models can call tools natively so the agent loop can pick
  // the native path per worker (survives restarts via settings.json).
  settings.modelCapabilities = Object.fromEntries(
    models.filter(m => m.supportsTools).map(m => [m.id, true])
  );
  // Cache the merged catalog so the cost bars and the NEW-model diff survive a
  // restart without a key round-trip (SETTINGS-MODELS-PLAN §2).
  settings.modelCatalogCache = {
    ...(settings.modelCatalogCache ?? {}),
    openrouter: { fetchedAt: new Date().toISOString(), models }
  };
  persistSettings();
  // A provider shipping a model is exactly the case G4 is about: stamp the
  // freshly fetched ids so the next settings read badges them (§3).
  refreshSeenModels();
  rebuildRuntimeConfig();
  return models;
});

// The Settings "Test" button (PROVIDERS-PLAN §4): one tiny call through the
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

// Auto-update via GitHub Releases (BUILD-AND-CICD-PLAN). Packaged builds only;
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
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
