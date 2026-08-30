// The engine: everything the app IS, with nothing Electron in it.
//
// Why this exists (DESIGN-SPEC.md §8). Flyt's outermost loop used to be a person
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
import { StackRunner, normalizeApprovalMode } from './stackRunner.js';
import { pickSafetyModel, SAFETY_MODEL_CANDIDATES } from './safetyCheck.js';
import { ProjectRegistry } from './projects.js';
import { Backlog } from './backlog.js';
import { FeedbackStore } from './feedback.js';
import { WorktreePool } from './worktree.js';
import { Ledger, pricesFromCatalog } from './ledger.js';
import { ReferenceLibrary, DEFAULT_REFERENCES } from './references.js';
import { configDirFor } from './workspace.js';
import { setKnownTools } from '../src/flowTypes.js';
import { diffSnapshot } from './snapshotDiff.js';
import { canServe, callModel } from './adapters/index.js';
import { classifyAdapterError } from './adapters/failures.js';
import {
  PROVIDER_IDS, KEYED_PROVIDERS, SUBSCRIPTION_PROVIDERS, DEFAULT_PRIORITY,
  migrateSettings, createResolver, createCapabilityCache
} from './modelSource.js';
import { claudeCredentialStatus, resolveClaudeCli } from './adapters/claudeCode.js';
import { codexCredentialStatus, resolveCodexCli } from './adapters/codexCli.js';
import { supportsToolsFor } from './agent.js';
import { v2Flag } from './v2.js';
import { LoopLog } from './loopLog.js';

const PUSH_COALESCE_MS = 80;
const PUSH_SNAPSHOT_RETRIES = 1;

// Search providers are not model providers: keeping their secrets in a
// separate settings bucket prevents them from entering model resolution while
// still giving tools the existing runtimeConfig.providerKeys lookup.
export const SEARCH_PROVIDER_IDS = Object.freeze(['brave', 'tavily']);

/** Apply one-way secret updates. Missing, empty, and unknown fields preserve what is stored. */
export function applySearchProviderKeys(settings, patch) {
  if (!patch || typeof patch !== 'object') return false;
  let changed = false;
  for (const provider of SEARCH_PROVIDER_IDS) {
    const raw = patch[provider];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const key = raw.trim();
    if (settings.searchProviders?.[provider]?.apiKey === key) continue;
    settings.searchProviders = { ...(settings.searchProviders ?? {}) };
    settings.searchProviders[provider] = {
      ...(settings.searchProviders[provider] ?? {}), apiKey: key,
    };
    changed = true;
  }
  return changed;
}

export async function probeSubscriptionCapability({ provider, model }, { call = callModel } = {}) {
  try {
    // callModel's public contract is one request object. Pin that shape here so
    // the tiny prompt, single attempt and hard deadline cannot be dropped by a
    // future refactor of this preflight.
    await call({
      provider, model, prompt: 'Reply with OK.', maxTokens: 1, stream: false,
      retry: { attempts: 1 }, timeout: { hardMs: 15_000, idleMs: 15_000 }
    });
    return { ok: true, status: 'usable' };
  } catch (error) {
    // Only the shared classifier's actual model-rejection category is
    // unsupported. Auth, quota, network and runtime failures are inconclusive.
    const failure = classifyAdapterError(error, { provider, model });
    return failure.code === 'capability'
      ? { ok: false, status: 'unsupported', reason: 'The provider rejected this model.' }
      : { ok: false, status: 'unknown', reason: 'The capability check did not complete.' };
  }
}

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
  warn = () => {},
  // Optional host-supplied, credential-safe capability probe. It receives only
  // provider/model and must return { ok }; the engine caches the result.
  capabilityProbe = null
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

  // The familiar Work entry and its editable workflow/model library still use
  // these stores. They are a day-to-day product surface, not a Loop fallback;
  // unattended Loop execution is canonical stacks + kernel only.
  // Keep the on-disk directory name stable so an upgrade does not orphan a
  // person's saved workflows; only the old architectural role is retired.
  const workflowRoot = path.join(userDataDir, 'compatibility');
  const flows = new FlowStore(path.join(workflowRoot, 'flows'));
  // Canonical v2 stacks live beside the legacy flow directory. StackStore can
  // read an existing flows/*.flow.yaml without mutation and retires that file
  // only when the stack is first written.
  // Keep the headless harness independent of the compiled v2 kernel. Electron
  // constructs StackStore after bootKernel's dynamic import supplies the one
  // canonical parser; the CLI can still manage Loop without kernel/dist.
  const stackRoot = seedFromBundle('stacks');
  const nodeLibrary = new NodeStore(path.join(workflowRoot, 'nodes'));
  flows.ensureDefaultPrompt();

  // The tool library is files too (DESIGN-SPEC.md §5): tools/<id>.json seeds from
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
  // settings.json lives in userData (never the repo). Shape (DESIGN-SPEC.md §6):
  //   { providers: { anthropic|openai|kimi|openrouter: { apiKey, keyKind? } },
  //     providerPriority: [providerId, ...],              // auto-source walk order
  //     activeModels: [{ id, source: 'auto'|providerId, enabled }],
  //     modelFacts:   { id: { name?, contextLength?, supportsTools?,
  //                           inUsdPerM?, outUsdPerM? } },   // D36 P0.2
  //     modelSets:    { setId: { name, models: [id, ...] } },  // D36
  //     workers: { executor: { provider, model } },
  //     projectStorage: 'workspace' | 'appdata',        // T2a
  //     approvalMode: 'ask' | 'smart' | 'always',
  //     safetyModel: 'auto' | modelId,
  //     projects: { open, active, recents, tabState } }  // D22 — tab session (T17)
  const settingsPath = path.join(userDataDir, 'settings.json');

  /**
   * Read the profile, telling "there isn't one" apart from "I could not read
   * it".
   *
   * Those two used to share a `catch` that returned defaults — and the very
   * next line persists, so an unreadable settings.json was silently REPLACED by
   * an empty one on the next launch. Every API key, every pinned model, every
   * worker assignment, gone, with nothing in the log and the original
   * overwritten. A file that cannot be parsed is the one moment where writing
   * over it is the worst available move.
   *
   * So a file that exists and will not parse is moved aside with a timestamp
   * and reported. The user starts from defaults either way, but the thing they
   * spent an afternoon configuring is still on disk beside the new one.
   */
  const loadSettings = () => {
    let raw;
    try {
      raw = fs.readFileSync(settingsPath, 'utf8');
    } catch (err) {
      // ENOENT is a fresh profile, which is not a problem and needs no noise.
      if (err?.code !== 'ENOENT') {
        warn(`could not read ${settingsPath} (${err.message}) — starting from defaults, and NOT overwriting it`);
        return { settings: migrateSettings({}), readable: false };
      }
      return { settings: migrateSettings({}), readable: true };
    }
    try {
      return { settings: migrateSettings(JSON.parse(raw)), readable: true };
    } catch (err) {
      const aside = `${settingsPath}.${new Date().toISOString().replace(/[:.]/g, '-')}.corrupt`;
      try { fs.renameSync(settingsPath, aside); }
      catch { /* if it cannot even be moved, refusing to write is still right */ }
      warn(`${settingsPath} is not valid JSON (${err.message}) — kept as ${aside}, starting from defaults`);
      return { settings: migrateSettings({}), readable: true };
    }
  };
  // Mutated in place by callers and then persisted — never reassigned, so a
  // consumer holding this reference stays correct.
  const { settings, readable: settingsReadable } = loadSettings();

  /**
   * Write the profile, atomically.
   *
   * Every front door boots an engine, and every boot persists. Several `flyt`
   * invocations at once — a loop in one terminal, a status check in another —
   * were each doing a non-atomic 90 KB overwrite, so a reader could catch a
   * half-written file and take the branch above. Write-then-rename makes a
   * reader see either the old file or the new one, never the middle.
   *
   * A profile we could not READ is never written over: whatever is there is
   * more valuable than what this process has in memory, which is nothing.
   */
  const persistSettings = () => {
    if (!settingsReadable) return false;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const tmp = `${settingsPath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
      fs.renameSync(tmp, settingsPath);
      return true;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing to clean up */ }
      warn(`could not save settings to ${settingsPath}: ${err.message}`);
      return false;
    }
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

  // The resolution rule (DESIGN-SPEC.md §6). Pinned source wins when it has a
  // key; 'auto' walks providerPriority, skipping disconnected providers and
  // providers that can't serve the id. Returns the fully-stamped call target.
  const resolveSource = createResolver({ hasKey, canServe, priority: () => settings.providerPriority });
  // Short-lived, in-memory capability results. A probe implementation can be
  // supplied by the host; keeping this cache out of settings prevents secrets
  // and vendor CLI output from being persisted.
  const capabilityCache = createCapabilityCache();
  // One minimal authenticated call is the only reliable capability signal for
  // subscription CLIs. It is intentionally not automatic during ordinary model
  // resolution; Loop/doctor invoke it only for selected models and the cache
  // bounds repeats.
  const effectiveCapabilityProbe = capabilityProbe ?? probeSubscriptionCapability;
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
  // save so a running StackRunner picks up changes without a restart (it holds a
  // reference to this object).
  const runtimeConfig = { ...baseConfig };

  function rebuildRuntimeConfig() {
    const workers = {};
    for (const [name, def] of Object.entries(baseConfig.workers)) {
      const override = settings.workers?.[name];
      let w = override?.provider && override?.model
        ? { provider: override.provider, model: override.model }
        : { provider: def.provider, model: def.model };
      // A worker declared with no model (the loop's own two) is UNSET, not
      // broken: it is how "no pin" and "no reviewer" stay expressible, and
      // resolving it would only stamp a key onto a model that does not exist.
      if (!w.provider || !w.model) { workers[name] = { provider: null, model: null }; continue; }
      // A model the user activated is resolved through the providers map: its
      // pinned source (or the priority walk for 'auto') decides who serves it,
      // and the key rides along (DESIGN-SPEC.md §6).
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
        w.supportsTools = supportsToolsFor(w, {
          modelCapabilities: settings.modelCapabilities, modelFacts: settings.modelFacts
        });
      }
      workers[name] = w;
    }
    runtimeConfig.workers = workers;
    // Per-provider key lookup for task workers persisted in runs/tasks.json,
    // which must never contain the key itself.
    runtimeConfig.providerKeys = Object.fromEntries(
      KEYED_PROVIDERS.filter(p => settings.providers?.[p]?.apiKey).map(p => [p, settings.providers[p].apiKey])
    );
    for (const provider of SEARCH_PROVIDER_IDS) {
      const key = settings.searchProviders?.[provider]?.apiKey;
      if (key) runtimeConfig.providerKeys[provider] = key;
    }
    // Connected subscription providers join the map with a sentinel — the
    // default-worker picker treats presence as "connected", and the adapters
    // ignore apiKey by design (the CLI owns auth).
    for (const p of SUBSCRIPTION_PROVIDERS) {
      if (hasKey(p)) runtimeConfig.providerKeys[p] = 'subscription';
    }
    runtimeConfig.resolveModelSource = resolveModelSource;
    // ONE routing policy (WR-04). The auto-source resolver already walked this
    // list; the default-worker picker did not, and started from its own
    // hard-coded table instead — so reordering providers in Settings moved some
    // calls and left others where they were. Both read this now, so the order
    // shown in Settings is the order that runs. Rebuilt on every settings
    // change, which is what lets a reorder take effect without a restart.
    runtimeConfig.providerPriority = [...(settings.providerPriority ?? DEFAULT_PRIORITY)];
    runtimeConfig.kimiKeyKind = settings.providers?.kimi?.keyKind ?? 'platform';
    runtimeConfig.modelCapabilities = settings.modelCapabilities ?? {};
    // Catalogue facts double as capability data when modelCapabilities is empty
    // — which it is everywhere except after a Settings catalogue fetch.
    runtimeConfig.modelFacts = settings.modelFacts ?? {};
    // A fan-out node pointed at a model set mints one lane per member (D36
    // P2.4), and drops members that are no longer active rather than minting a
    // lane that cannot run — so the runner needs both lists.
    runtimeConfig.modelSets = settings.modelSets ?? {};
    // Workflow definitions name stable Free/Economy/Standard/Frontier tiers;
    // the installation decides which current models those names mean.
    runtimeConfig.workflowModelTiers = settings.workflowModelTiers ?? {};
    runtimeConfig.activeModels = settings.activeModels ?? [];
    runtimeConfig.categoryWorkers = baseConfig.categoryWorkers ?? {};
    // A model per effort band for the loop (DESIGN-SPEC.md §8). Settings win over
    // config.json, the same way every other worker override does — the bands
    // are a machine's cost decision, not a property of the repository.
    runtimeConfig.loop = {
      ...baseConfig.loop,
      ...(Object.keys(settings.loopModels ?? {}).length ? { models: settings.loopModels } : {})
    };
    // 'ask' is the shipped default: an agent with a shell should not run
    // unattended because nobody got round to choosing.
    runtimeConfig.approvalMode = normalizeApprovalMode(settings.approvalMode ?? 'ask');
    // The v2 stack, off unless somebody said otherwise (D62). Resolved here so
    // there is one answer per process rather than one per call site — and it is
    // only ever an ANSWER: nothing in core/ imports the v2 tree, which is what
    // makes "the app is unchanged with the flag off" checkable.
    runtimeConfig.v2 = v2Flag({ settings }).enabled;
    // What 'smart' mode screens with. The runner gets a resolver, never a key.
    runtimeConfig.safety = { model: effectiveSafetyModel(), resolveModelSource };
    // The Python sidecar (core/python.js, TOOLS.md). A tool that borrows a
    // library which is not JavaScript has to find the interpreter those
    // packages were installed into, and that is a fact about the INSTALLATION —
    // which is exactly what this map carries. Without it a sidecar tool would
    // have to guess `python` on PATH, which on this platform is as likely to be
    // a Store stub that opens an installer as it is to be a working 3.11.
    runtimeConfig.userDataDir = userDataDir;
    runtimeConfig.python = settings.python ?? {};
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
      searchProviders: Object.fromEntries(SEARCH_PROVIDER_IDS.map(provider => [provider, {
        hasKey: Boolean(settings.searchProviders?.[provider]?.apiKey),
      }])),
      hasKey: connectable.some(hasKey),
      claudeSubscriptionActive: hasKey('claude-code'),
      providerPriority: settings.providerPriority ?? [...DEFAULT_PRIORITY],
      activeModels,
      // DECISIONS.md D36: what each model costs and can read, and the named
      // sets built out of them. Facts are catalog data, not secrets — every
      // picker in the app renders them.
      modelFacts: settings.modelFacts ?? {},
      modelPopularity: settings.modelPopularity ?? null,
      modelSets: settings.modelSets ?? {},
      workflowModelTiers: settings.workflowModelTiers ?? {},
      // What the Loop view's per-band pickers show. Model ids, never keys.
      loopModels: settings.loopModels ?? {},
      // The backlog chat's model, when this person has chosen one (D45).
      chat: settings.chat ?? {},
      workers: Object.fromEntries(
        Object.entries(runtimeConfig.workers).map(([name, w]) => [name, { provider: w.provider, model: w.model }])
      ),
      summary: {
        connected: connectable.filter(hasKey).length,
        activeModelCount: activeModels.filter(m => m.enabled !== false && m.pinned !== false).length
      },
      projectStorage: settings.projectStorage === 'appdata' ? 'appdata' : 'workspace',
      approvalMode: normalizeApprovalMode(settings.approvalMode ?? 'ask'),
      v2: v2Flag({ settings }).enabled,
      safetyModel: settings.safetyModel ?? 'auto',
      resolvedSafetyModel: effectiveSafetyModel(),
      judgeModel: settings.judgeModel ?? '',
      safetyCandidates: SAFETY_MODEL_CANDIDATES.map(c => ({
        ...c, connected: [c.provider, ...(c.altProviders ?? [])].some(hasKey)
      }))
    };
  }

  // The reference library (DESIGN-SPEC.md §8): app-level, not per project, because
  // prior art is portable in exactly the way a backlog is not — and read-only,
  // so one copy shared by every project is correct rather than merely thrifty.
  const references = new ReferenceLibrary(runtimeConfig.referenceRoot ?? null, {
    repos: runtimeConfig.references ?? DEFAULT_REFERENCES
  });

  // --- The loop's log (DESIGN-SPEC.md §8) ---
  // One line per decision the supervisor makes, pushed live AND kept in a
  // bounded ring per project. The ring is what lets a viewer that attaches at
  // 18:00 see what happened at 09:00 — a live-only stream shows an empty panel
  // to the one person who most needs the history.
  const LOOP_LOG_MAX = 500;
  const loopLogs = new Map();
  const loopFiles = new Map();

  /** The day-file store for a project, beside its ledger. */
  function loopLogFor(projectId) {
    let store = loopFiles.get(projectId);
    if (store !== undefined) return store;
    const entry = registry.get(projectId);
    const root = entry?.folder ?? entry?.appDir;
    loopFiles.set(projectId, store = root ? new LoopLog(path.join(configDirFor(root), 'loop')) : null);
    return store;
  }

  /**
   * One line of the loop's account of itself.
   *
   * Three destinations, and the file is the one that matters: the ring serves
   * a viewer attached right now, the event serves one attaching in a second,
   * and the file serves the person who comes back in the morning after the
   * process is gone.
   *
   * @param projectId — whose loop.
   * @param line — what happened.
   * @param meta.taskId — the task it happened to, when the caller knows.
   */
  function emitLoop(projectId, line, { taskId = null } = {}) {
    const entry = { projectId, at: new Date().toISOString(), line: String(line), taskId: taskId ?? null };
    let ring = loopLogs.get(projectId);
    if (!ring) loopLogs.set(projectId, ring = []);
    ring.push(entry);
    if (ring.length > LOOP_LOG_MAX) ring.splice(0, ring.length - LOOP_LOG_MAX);
    loopLogFor(projectId)?.append(entry);
    log(`[loop] ${line}`);
    if (canEmit()) emit('loop:event', entry);
  }

  /**
   * What the loop said, newest last.
   *
   * The file wins where there is one: it outlives the process, and this
   * process's own lines are in it too. The ring is the fallback for a project
   * whose storage is unwritable, which is exactly the state this used to be in
   * all the time.
   */
  function loopLog(projectId, { date = null, taskId = null, tail = LOOP_LOG_MAX } = {}) {
    const fromFile = loopLogFor(projectId)?.read({ date, taskId, tail }) ?? [];
    if (fromFile.length) return fromFile.map(e => ({ projectId, ...e }));
    const ring = (loopLogs.get(projectId) ?? []).filter(e => !taskId || e.taskId === taskId);
    return tail && ring.length > tail ? ring.slice(-tail) : ring.slice();
  }

  // The chat's live channel (DECISIONS.md D45), mirroring `loop:event` exactly.
  // Not ring-buffered: a chat turn's transcript is already persisted per turn
  // in .flyt/chats/<id>.jsonl, so the only thing this carries is the tokens
  // arriving BEFORE that write — which have nowhere else to be.
  function emitChat(projectId, event) {
    if (canEmit()) emit('chat:event', { projectId, at: new Date().toISOString(), ...event });
  }

  // Attended workflow interaction: approvals, direct block questions, and a
  // degraded-supervisor warning. Durable run facts stay in session.jsonl;
  // this channel only carries the prompt that needs a person right now.
  function emitWorkflow(projectId, event) {
    if (canEmit()) emit('workflow:event', { projectId, at: new Date().toISOString(), ...event });
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
  const pushState = new Map(); // projectId -> { pending, eventJobs, channels, lastActivity, activityTimer }
  const pushStateFor = projectId => {
    let s = pushState.get(projectId);
    if (!s) pushState.set(projectId, s = {
      pending: new Map(),   // runId -> serialized snapshot job
      eventJobs: new Map(), // runId -> buffered canonical session events
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
    const entry = registry.get(projectId);
    const live = [...new Set([
      ...(entry.runner?.live ?? []),
      ...(entry.kernelRuns?.keys() ?? []),
    ])];
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

  const pushSnapshotFor = (projectId, snapshotFor) => runId => {
    const s = pushStateFor(projectId);
    const existing = s.pending.get(runId);
    if (existing) {
      // A scheduled read already sees all state written before it starts. A
      // notification DURING a read needs exactly one trailing read; retaining
      // the job in `pending` is also what prevents two async snapshots from
      // racing and publishing revisions backwards.
      if (existing.running) existing.dirty = true;
      return;
    }

    const job = { timer: null, running: false, dirty: false, failures: 0, snapshotFor };
    const finish = () => {
      job.running = false;
      if (job.dirty) {
        job.dirty = false;
        job.timer = setTimeout(flush, PUSH_COALESCE_MS);
      } else if (s.pending.get(runId) === job) {
        s.pending.delete(runId);
      }
    };
    const flush = async () => {
      job.timer = null;
      job.running = true;
      job.dirty = false;
      if (pushState.get(projectId) !== s || !canEmit()) { finish(); return; }
      broadcastActivity(projectId);
      // Consumer says this project isn't worth diffing for right now (a
      // background tab): skip the snapshot/diff work entirely. Its channel
      // baseline goes stale, but a resync via run:snapshot re-baselines it.
      if (!shouldPush(projectId)) { finish(); return; }
      let next;
      try {
        next = await job.snapshotFor(runId);
        job.failures = 0;
      } catch {
        // A session append can briefly race filesystem visibility. Retry once
        // without requiring another event, but stay bounded if the source is
        // genuinely unreadable. A real notification received during the failed
        // read also keeps `dirty` true and therefore earns a trailing attempt.
        if (job.failures < PUSH_SNAPSHOT_RETRIES) {
          job.failures += 1;
          job.dirty = true;
        }
        finish();
        return;
      }
      // Closing a project replaces its push state. An in-flight read from the
      // old state must not wake the renderer afterward.
      if (pushState.get(projectId) !== s || !canEmit()) { finish(); return; }
      const chan = s.channels.get(runId);
      // No baseline yet: send the full snapshot so the consumer has something
      // to patch against.
      if (!chan) {
        const rev = 1;
        s.channels.set(runId, { snapshot: next, rev });
        emit('run:update', { projectId, runId, rev, base: null, full: next });
        finish();
        return;
      }
      const patch = diffSnapshot(chan.snapshot, next);
      if (patch) {
        const rev = chan.rev + 1;
        s.channels.set(runId, { snapshot: next, rev });
        emit('run:update', { projectId, runId, rev, base: chan.rev, patch });
      }
      finish(); // no patch still completes or schedules the dirty trailing read
    };
    s.pending.set(runId, job);
    job.timer = setTimeout(flush, PUSH_COALESCE_MS);
  };
  const pushUpdateFor = projectId => pushSnapshotFor(
    projectId, runId => registry.get(projectId).store.snapshot(runId)
  );

  // Canonical kernel events already contain the exact live delta Trace needs.
  // Forward them in small batches instead of rebuilding, diffing and then
  // re-reading an ever-growing snapshot and log for every stream notification.
  const pushEventsFor = projectId => (runId, event) => {
    if (!runId || !event || !Number.isFinite(event.seq) || !canEmit()) return;
    const s = pushStateFor(projectId);
    let job = s.eventJobs.get(runId);
    if (!job) {
      job = { events: [], timer: null };
      s.eventJobs.set(runId, job);
    }
    job.events.push(event);
    if (job.timer) return;
    job.timer = setTimeout(() => {
      job.timer = null;
      if (pushState.get(projectId) !== s || !canEmit() || !shouldPush(projectId)) {
        job.events.length = 0;
        s.eventJobs.delete(runId);
        return;
      }
      const events = job.events.splice(0);
      if (events.length) emit('run:update', { projectId, runId, events });
      if (!job.events.length) s.eventJobs.delete(runId);
    }, PUSH_COALESCE_MS);
  };
  const dropPushState = projectId => {
    const s = pushState.get(projectId);
    if (!s) return;
    for (const job of s.pending.values()) if (job.timer) clearTimeout(job.timer);
    for (const job of s.eventJobs.values()) if (job.timer) clearTimeout(job.timer);
    if (s.activityTimer) clearTimeout(s.activityTimer);
    pushState.delete(projectId);
  };

  // --- The backlog, one per project (DESIGN-SPEC.md §8) ---
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

  // Tool feedback (DESIGN-SPEC.md §8), same canonical-location rule as the backlog:
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

  // One worktree pool per project (DESIGN-SPEC.md §8). The trees live OUTSIDE the
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

  // Where a project keeps the state the loop owns — the backlog, the ledger,
  // the feedback pile, the scorecards, the archive. Always the MAIN checkout's
  // config dir, never a worktree's and never a benchmark clone's (§5.2).
  // Null for the legacy unbound scratch project, which has nowhere to put any
  // of it.
  function configDirOf(projectId) {
    const entry = registry.get(projectId);
    const root = entry.folder ?? entry.appDir;
    return root ? configDirFor(root) : null;
  }

  // The spend record (DESIGN-SPEC.md §8), per project, beside the backlog.
  const ledgers = new Map();
  function ledgerFor(projectId) {
    let l = ledgers.get(projectId);
    if (l) return l;
    const entry = registry.get(projectId);
    const root = entry.folder ?? entry.appDir;
    if (!root) return null;
    ledgers.set(projectId, l = new Ledger(path.join(configDirFor(root), 'ledger'),
      // The catalog prices everything; loop.prices overrides where it speaks.
      { prices: pricesFromCatalog(runtimeConfig.modelFacts, runtimeConfig.loop?.prices) }));
    return l;
  }

  // Filled in by core/api.js, which owns the per-project Supervisor map. The
  // engine holds the slot so a StackRunner can reach the loop without either
  // module importing the other.
  const loopDriver = { start: null, status: null };
  const setLoopDriver = d => Object.assign(loopDriver, d);

  const registry = new ProjectRegistry({
    defaultRunsDir: path.join(dataRoot, 'runs'),
    appDataDir: userDataDir,
    // T2a: the storage location is a Settings choice, read at project-open time.
    getStorage: () => (settings.projectStorage === 'appdata' ? 'appdata' : 'workspace'),
    createRunner: (store, projectId) => {
      const runner = new StackRunner(store, runtimeConfig, pushUpdateFor(projectId), nodeLibrary, flows);
      // Lazy for the reason above, and a property rather than a constructor
      // argument so every existing StackRunner call site is untouched.
      Object.defineProperty(runner, 'backlog', { get: () => backlogFor(projectId), configurable: true });
      Object.defineProperty(runner, 'ledger', { get: () => ledgerFor(projectId), configurable: true });
      // The worktree pool, for read_run's diff. Lazy for the same reason the
      // two above are: a project that never runs the loop never makes one.
      Object.defineProperty(runner, 'pool', { get: () => { try { return poolFor(projectId); } catch { return null; } }, configurable: true });
      // A flow's `loop` node hands its tasks to the SAME supervisor the Loop
      // page drives — one queue, one picker, one process (D36 P4.2). api.js
      // owns the supervisor map, so it registers the driver; this is only the
      // slot it registers into.
      Object.defineProperty(runner, 'loopHost', {
        get: () => ({
          projectId,
          backlog: backlogFor(projectId),
          ledger: ledgerFor(projectId),
          start: opts => loopDriver.start?.({ projectId, ...opts }),
          status: () => loopDriver.status?.(projectId) ?? null
        }),
        configurable: true
      });
      Object.defineProperty(runner, 'feedback', { get: () => feedbackFor(projectId), configurable: true });
      runner.references = references;
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
    flows, stackRoot, nodeLibrary, toolLibrary, registry, backlogFor, feedbackFor, poolFor, ledgerFor, references,
    configDirOf,
    // Config + settings
    baseConfig, runtimeConfig, settings, persistSettings, rebuildRuntimeConfig, publicSettings,
    setLoopDriver,
    // Providers
    hasKey, subscriptionStatus, resolveModelSource, capabilityCache,
    capabilityProbe: effectiveCapabilityProbe, effectiveSafetyModel,
    // Push
    pushStateFor, broadcastActivity, pushUpdateFor, pushSnapshotFor, pushEventsFor,
    emitLoop, loopLog, loopLogFor, emitChat, emitWorkflow,
    // A project id that is gone for good (an appdata project adopted into a
    // real folder) takes its push channels with it.
    dropPushState,
    // Convenience for consumers that hold a project id
    project: id => registry.get(id)
  };
}
