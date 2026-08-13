// The engine: everything the app IS, with nothing Electron in it.
//
// Why this exists (LOOP-PLAN §4.2). Flyt's outermost loop used to be a person
// pressing Run, so the whole assembly — stores, settings, provider resolution,
// the project registry, the push plumbing — lived inside electron/main.js and
// could only be reached from a renderer over IPC. Nothing else could drive the
// app: not a headless supervisor, not a CLI, not an AI.
//
// So the assembly moved here, parameterized by paths and by two callbacks, and
// `electron/main.js` became one of its consumers rather than its owner. The
// other consumers are the headless supervisor and the CLI, which get the same
// engine with the same semantics — one implementation, several front doors.
//
// What deliberately stays in electron/main.js: windows, menus, dialogs, native
// notifications, `shell.openPath`, app lifecycle. Those are not "the app", they
// are how a human touches it.
import fs from 'node:fs';
import path from 'node:path';
import { FlowStore } from './flowstore.js';
import { NodeStore } from './nodestore.js';
import { ToolStore } from './toolstore.js';
import { loadLibrary } from './tools/index.js';
import { FlowRunner, normalizeApprovalMode } from './flowRunner.js';
import { pickSafetyModel, SAFETY_MODEL_CANDIDATES } from './safetyCheck.js';
import { ProjectRegistry } from './projects.js';
import { Backlog } from './backlog.js';
import { FeedbackStore } from './feedback.js';
import { WorktreePool } from './worktree.js';
import { Ledger } from './ledger.js';
import { configDirFor } from './workspace.js';
import { setKnownTools } from '../src/flowTypes.js';
import { diffSnapshot } from './snapshotDiff.js';
import { canServe } from './adapters/index.js';
import {
  PROVIDER_IDS, KEYED_PROVIDERS, SUBSCRIPTION_PROVIDERS, DEFAULT_PRIORITY,
  migrateSettings, createResolver
} from './modelSource.js';
import { claudeCredentialStatus, resolveClaudeCli } from './adapters/claudeCode.js';
import { codexCredentialStatus, resolveCodexCli } from './adapters/codexCli.js';

const PUSH_COALESCE_MS = 80;

/**
 * @param {object} opts
 * @param {string} opts.projectRoot   The app's own code + bundled assets (read-only when packaged).
 * @param {string} opts.dataRoot      Where mutable state lives (the checkout in dev, userData when packaged).
 * @param {string} opts.userDataDir   Where settings.json lives — never the repo.
 * @param {(type: string, payload: object) => void} [opts.emit]
 *        Outbound events: 'run:update' (diffed snapshots) and 'project:activity'.
 *        Electron forwards them over IPC; the server pushes them down SSE.
 * @param {() => boolean} [opts.canEmit]   Is anyone listening at all?
 * @param {(projectId: string) => boolean} [opts.shouldPush]
 *        Gate on the EXPENSIVE half (snapshot + diff). Electron passes
 *        "is this the active tab", because a background tab resyncs from files
 *        on activation and diffing for nobody is wasted work on every wave.
 */
export function createEngine({
  projectRoot,
  dataRoot,
  userDataDir,
  emit = () => {},
  canEmit = () => true,
  shouldPush = () => true,
  log = () => {},
  warn = () => {}
} = {}) {
  const dataDir = name => {
    const dir = path.join(dataRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // Copy a bundled asset directory out of the (read-only) app bundle into the
  // writable data root. Flat directories only — deliberately shallow so it
  // works over the asar fs shim.
  //
  // Copying is per FILE, not per directory: a file is written only when it is
  // missing at the destination. That gives both halves of what we want — the
  // user's edits to a seeded flow are never clobbered by an update, and a NEW
  // default flow added in a later release still lands on existing installs
  // instead of being locked out by a one-shot first-run copy.
  const seedFromBundle = name => {
    const dest = dataDir(name);
    if (dataRoot === projectRoot) return dest; // dev: the bundle IS the data dir
    const src = path.join(projectRoot, name);
    try {
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const to = path.join(dest, entry.name);
        if (fs.existsSync(to)) continue;
        fs.writeFileSync(to, fs.readFileSync(path.join(src, entry.name)));
      }
    } catch (err) {
      warn(`could not seed ${name} from the app bundle: ${err.message}`);
    }
    return dest;
  };

  const baseConfig = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8'));

  // Flows and Node Library templates stay global for v1 (D22 T2) — reusable
  // expertise shared across every project tab. Runs are per-project; their
  // stores live in the project registry below.
  const flows = new FlowStore(seedFromBundle('flows'));
  const nodeLibrary = new NodeStore(dataDir('nodes')); // seeds itself from code on first launch
  flows.ensureDefaultPipeline(); // the classic pipeline, shipped as an editable workflow
  flows.ensureSeedPipelines();   // the tiered Low/Medium/High/Ultra pipelines (MODES-COMPARE T7)

  // The tool library is files too (TOOLS-PLAN §4.1): tools/<id>.json seeds from
  // the built-in modules, and the runtime registry is loaded FROM the files — so
  // what a run can call is what the library says, not what happens to be
  // imported. App-level like nodes/: capability is portable, expertise is not.
  const toolLibrary = new ToolStore(dataDir('tools'));
  const toolLoad = loadLibrary(toolLibrary.listFull());
  // Template grants are filtered against the real library here as well as in
  // the renderer: normalizeTemplate() drops unknown tool ids, and without this
  // it would drop every tool the built-ins don't happen to include.
  setKnownTools(toolLoad.loaded);
  for (const { id, reason } of toolLoad.skipped) warn(`tool "${id}" not loaded: ${reason}`);
  for (const { file, error } of toolLibrary.problems) warn(`tools/${file}: ${error}`);

  // --- Settings & secrets ---
  // settings.json lives in userData (never the repo). Shape (PROVIDERS-PLAN §1):
  //   { providers: { anthropic|openai|kimi|openrouter: { apiKey, keyKind? } },
  //     providerPriority: [providerId, ...],              // auto-source walk order
  //     activeModels: [{ id, source: 'auto'|providerId, enabled }],
  //     workers: { executor: { provider, model } },
  //     projectStorage: 'workspace' | 'appdata',        // T2a
  //     approvalMode: 'ask' | 'smart' | 'always',
  //     safetyModel: 'auto' | modelId,
  //     projects: { open, active, recents, tabState } }  // D22 — tab session (T17)
  const settingsPath = path.join(userDataDir, 'settings.json');
  const loadSettings = () => {
    try { return migrateSettings(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); }
    catch { return migrateSettings({}); }
  };
  // Mutated in place by callers and then persisted — never reassigned, so a
  // consumer holding this reference stays correct.
  const settings = loadSettings();
  const persistSettings = () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  };
  persistSettings(); // seal the migration (legacy openrouterApiKey is gone after this)

  // Sign-in + CLI presence for one subscription provider (cheap fs checks).
  function subscriptionStatus(provider) {
    const sub = settings.subscriptions?.[provider] ?? {};
    const home = sub.home || null;
    if (provider === 'claude-code') {
      return { ...claudeCredentialStatus(home), cli: resolveClaudeCli(sub.cliPath || null) };
    }
    return { ...codexCredentialStatus(home), cli: resolveCodexCli(sub.cliPath || null) };
  }

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

  // The resolution rule (PROVIDERS-PLAN §2). Pinned source wins when it has a
  // key; 'auto' walks providerPriority, skipping disconnected providers and
  // providers that can't serve the id. Returns the fully-stamped call target.
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

  // The classifier 'smart' mode actually uses: the user's pin, or — for 'auto' —
  // the cheapest candidate whose provider has a key. Null when no provider is
  // connected at all, which checkToolCall reports as 'caution'.
  const effectiveSafetyModel = () => pickSafetyModel(settings.safetyModel ?? 'auto', hasKey);

  // Runtime config = config.json defaults merged with settings.json overrides,
  // with each worker's provider key injected. Rebuilt IN PLACE on every settings
  // save so a running FlowRunner picks up changes without a restart (it holds a
  // reference to this object).
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
      // and the key rides along (PROVIDERS-PLAN §4).
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
      // in settings.json). Unknown models fall back to the text tool protocol.
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
    runtimeConfig.resolveModelSource = resolveModelSource;
    runtimeConfig.kimiKeyKind = settings.providers?.kimi?.keyKind ?? 'platform';
    runtimeConfig.modelCapabilities = settings.modelCapabilities ?? {};
    runtimeConfig.categoryWorkers = baseConfig.categoryWorkers ?? {};
    // 'ask' is the shipped default: an agent with a shell should not run
    // unattended because nobody got round to choosing.
    runtimeConfig.approvalMode = normalizeApprovalMode(settings.approvalMode ?? 'ask');
    // What 'smart' mode screens with. The runner gets a resolver, never a key.
    runtimeConfig.safety = { model: effectiveSafetyModel(), resolveModelSource };
  }
  rebuildRuntimeConfig();

  // What a UI is allowed to see: per-provider hasKey flags (never the keys),
  // the priority order, the active-model registry, worker assignments, and a
  // small connected/model-count summary for the overview UI.
  function publicSettings() {
    const providers = Object.fromEntries(PROVIDER_IDS.map(p => {
      const entry = {
        hasKey: hasKey(p),
        ...(p === 'kimi' ? { keyKind: settings.providers?.kimi?.keyKind ?? 'platform' } : {})
      };
      // Subscription card state: opted in? signed in? CLI found? Paths shown
      // are locations, never contents.
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
      hasKey: connectable.some(hasKey),
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
      projectStorage: settings.projectStorage === 'appdata' ? 'appdata' : 'workspace',
      approvalMode: normalizeApprovalMode(settings.approvalMode ?? 'ask'),
      safetyModel: settings.safetyModel ?? 'auto',
      resolvedSafetyModel: effectiveSafetyModel(),
      judgeModel: settings.judgeModel ?? '',
      safetyCandidates: SAFETY_MODEL_CANDIDATES.map(c => ({
        ...c, connected: [c.provider, ...(c.altProviders ?? [])].some(hasKey)
      }))
    };
  }

  // --- Push plumbing (per project) ---
  // Bursts of state changes (parallel waves, streaming chunks) coalesce into at
  // most one push per (project, run) per tick window: the snapshot is built from
  // file state when the timer fires, so the last write always wins.
  //
  // Incremental push (V1 task 5): we keep the last snapshot sent per run plus a
  // monotonic rev, and push only the diff. The consumer applies patches on top
  // of the full snapshot it fetched via run:snapshot; the rev/base pair lets it
  // detect a missed update and resync.
  const pushState = new Map(); // projectId -> { pending, channels, lastActivity, activityTimer }
  const pushStateFor = projectId => {
    let s = pushState.get(projectId);
    if (!s) pushState.set(projectId, s = {
      pending: new Map(),   // runId -> timer
      channels: new Map(),  // runId -> { snapshot, rev }
      lastActivity: null,
      activityTimer: null
    });
    return s;
  };

  // Tell consumers which projects have live runs. The trailing re-check catches
  // the final write of a run (whose coalesce timer can fire before the runner
  // removes it from `live`), so a live indicator can't stick on.
  function broadcastActivity(projectId, { recheck = true } = {}) {
    if (!canEmit()) return;
    const s = pushStateFor(projectId);
    const live = [...(registry.get(projectId).runner?.live ?? [])];
    const sig = live.join('\n');
    if (sig !== s.lastActivity) {
      s.lastActivity = sig;
      emit('project:activity', { projectId, live });
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
      if (!canEmit()) return;
      broadcastActivity(projectId);
      // Consumer says this project isn't worth diffing for right now (a
      // background tab): skip the snapshot/diff work entirely. Its channel
      // baseline goes stale, but a resync via run:snapshot re-baselines it.
      if (!shouldPush(projectId)) return;
      const entry = registry.get(projectId);
      const next = entry.store.snapshot(runId);
      const chan = s.channels.get(runId);
      // No baseline yet: send the full snapshot so the consumer has something
      // to patch against.
      if (!chan) {
        const rev = 1;
        s.channels.set(runId, { snapshot: next, rev });
        emit('run:update', { projectId, runId, rev, base: null, full: next });
        return;
      }
      const patch = diffSnapshot(chan.snapshot, next);
      if (!patch) return; // nothing actually changed — skip the wake-up
      const rev = chan.rev + 1;
      s.channels.set(runId, { snapshot: next, rev });
      emit('run:update', { projectId, runId, rev, base: chan.rev, patch });
    }, PUSH_COALESCE_MS));
  };

  // --- The backlog, one per project (LOOP-PLAN §5) ---
  //
  // Rooted at the project's CANONICAL config dir — the main checkout's
  // `.flyt/backlog/`, never a worktree's. That is the whole invariant of §5.2:
  // the queue must sit outside the thing being edited, or parallel tasks
  // conflict on it and a task can rewrite its own priority.
  //
  // Resolved lazily and memoized, because createRunner runs while the registry
  // entry is still being built — asking the registry for the entry from inside
  // its own constructor would recurse.
  const backlogs = new Map();
  function backlogFor(projectId) {
    let b = backlogs.get(projectId);
    if (b) return b;
    const entry = registry.get(projectId);
    const root = entry.folder ?? entry.appDir;
    if (!root) return null; // the legacy unbound scratch project has nowhere to put one
    backlogs.set(projectId, b = new Backlog(path.join(configDirFor(root), 'backlog')));
    return b;
  }

  // Tool feedback (LOOP-PLAN §12), same canonical-location rule as the backlog:
  // one pile per project, in the main checkout, never inside a worktree.
  const feedbackStores = new Map();
  function feedbackFor(projectId) {
    let f = feedbackStores.get(projectId);
    if (f) return f;
    const entry = registry.get(projectId);
    const root = entry.folder ?? entry.appDir;
    if (!root) return null;
    feedbackStores.set(projectId, f = new FeedbackStore(path.join(configDirFor(root), 'feedback')));
    return f;
  }

  // One worktree pool per project (LOOP-PLAN §6.1). The trees live OUTSIDE the
  // repo root — a nested checkout inside the working tree confuses grep, test
  // runners and the agent's own file tools — so they go under the data root,
  // keyed by project.
  const pools = new Map();
  function poolFor(projectId) {
    let p = pools.get(projectId);
    if (p) return p;
    const entry = registry.get(projectId);
    const root = entry.folder;
    if (!root) return null; // only a real repo can have worktrees
    // Deliberately NOT under dataRoot: in development that is the checkout
    // itself, which would put worktrees inside the repo (§6.1). `worktreeRoot`
    // in config.json overrides; the default is under the user's home.
    const base = runtimeConfig.worktreeRoot
      ? path.join(runtimeConfig.worktreeRoot, path.basename(root))
      : null;
    pools.set(projectId, p = new WorktreePool(root, base));
    return p;
  }

  // The spend record (LOOP-PLAN §9), per project, beside the backlog.
  const ledgers = new Map();
  function ledgerFor(projectId) {
    let l = ledgers.get(projectId);
    if (l) return l;
    const entry = registry.get(projectId);
    const root = entry.folder ?? entry.appDir;
    if (!root) return null;
    ledgers.set(projectId, l = new Ledger(path.join(configDirFor(root), 'ledger'),
      { prices: runtimeConfig.loop?.prices ?? {} }));
    return l;
  }

  const registry = new ProjectRegistry({
    defaultRunsDir: path.join(dataRoot, 'runs'),
    appDataDir: userDataDir,
    // T2a: the storage location is a Settings choice, read at project-open time.
    getStorage: () => (settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'),
    createRunner: (store, projectId) => {
      const runner = new FlowRunner(store, runtimeConfig, pushUpdateFor(projectId), nodeLibrary);
      // Lazy for the reason above, and a property rather than a constructor
      // argument so every existing FlowRunner call site is untouched.
      Object.defineProperty(runner, 'backlog', { get: () => backlogFor(projectId), configurable: true });
      Object.defineProperty(runner, 'feedback', { get: () => feedbackFor(projectId), configurable: true });
      // Nothing is live when a project first opens in this process, so any run
      // still in a non-terminal stage was cut off by the app dying. Flag those
      // once so the run view can offer Resume (V1 task 7).
      const interrupted = runner.reconcileInterrupted();
      if (interrupted.length) log(`${projectId}: ${interrupted.length} interrupted run(s) marked resumable`);
      return runner;
    },
    onPersist: () => {
      settings.projects = registry.serialize();
      persistSettings();
    }
  });

  return {
    // Paths
    projectRoot, dataRoot, userDataDir, settingsPath, dataDir, seedFromBundle,
    // Stores
    flows, nodeLibrary, toolLibrary, registry, backlogFor, feedbackFor, poolFor, ledgerFor,
    // Config + settings
    baseConfig, runtimeConfig, settings, persistSettings, rebuildRuntimeConfig, publicSettings,
    // Providers
    hasKey, subscriptionStatus, resolveModelSource, effectiveSafetyModel,
    // Push
    pushStateFor, broadcastActivity, pushUpdateFor,
    // A project id that is gone for good (an appdata project adopted into a
    // real folder) takes its push channels with it.
    dropPushState: projectId => pushState.delete(projectId),
    // Convenience for consumers that hold a project id
    project: id => registry.get(id)
  };
}
