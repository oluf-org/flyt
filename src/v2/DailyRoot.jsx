import { adoptAssetDraft } from '../AssetComposer.jsx';
import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { hydrateDaily } from './dailyStartup.js';
import { createHistoryFeed } from './historyFeed.js';
import { createBuildHistoryReader } from './buildHistory.js';
import Lander from '../Lander.jsx';
import { ModelMetaProvider } from '../ModelPicker.jsx';
import TabDeck from '../TabDeck.jsx';
import TabStrip, { NewTabPage } from '../TabStrip.jsx';
import Shell from './Shell.jsx';
import { BUILD, CHATS, GOALS, INITIAL, MODELS, WORK } from './shellRouting.js';
import { initialFlowId, initialModeId } from './dailyWorkModel.js';
import { defaultModeId } from './workflowUx.js';
import {
  DEFAULT_WORKFLOW_MODEL_TIER, workflowModelSelection,
} from '../modelTiers.js';
import {
  dailyProjectBridge, readDailyRun, subscribeDailyRun,
} from './dailyWorkBridge.js';

const cleanIpcError = error => String(error?.message ?? error)
  .replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

function liveByProject(tabs) {
  return Object.fromEntries((tabs ?? []).map(tab => [tab.id, tab.live ?? 0]));
}

/**
 * The day-to-day host around the v2 surfaces.
 *
 * This is intentionally an integration controller, not a revived App.jsx. It
 * owns tabs, the prompt launch, and the run being watched; Build still owns
 * canonical authoring and Shell still owns destination/Trace routing.
 */
const ModelsPage = lazy(() => import('../ModelsPage.jsx'));
const Settings = lazy(() => import('../Settings.jsx'));
const HistoryPage = lazy(() => import('./HistoryPage.jsx'));
const ChatHistoryPage = lazy(() => import('./ChatHistoryPage.jsx'));

export default function DailyRoot() {
  const [startupReady, setStartupReady] = useState(false);
  const [build, setBuild] = useState(null);
  const [edits, setEdits] = useState(0);
  const [reviewRevision, setReviewRevision] = useState(0);
  // The plugin catalog changes without any edit or review: a package finishes
  // installing, a fiber fails, the manager removes a row. Counting those is how
  // the Library redraws for a change nothing in this host initiated.
  const [pluginRevision, setPluginRevision] = useState(0);
  const [uiExtensionRevision, setUiExtensionRevision] = useState(0);
  const [location, setLocation] = useState(INITIAL);
  const locationRef = useRef(location);
  locationRef.current = location;
  const [projects, setProjects] = useState({ tabs: [], active: null });
  const [recents, setRecents] = useState([]);
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState(null);
  const [modeId, setModeId] = useState(null);
  const [configs, setConfigs] = useState({});
  const [settings, setSettings] = useState(null);
  const [runs, setRuns] = useState([]);
  const historyFeed = useMemo(() => createHistoryFeed(window.flyt, projects.active), [projects.active]);
  const historyState = useSyncExternalStore(historyFeed.subscribe, historyFeed.getSnapshot, historyFeed.getSnapshot);
  const activities = historyState.rows;
  const [watching, setWatching] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [tabLive, setTabLive] = useState({});
  const [deck, setDeck] = useState(null);
  const [workflowInteraction, setWorkflowInteraction] = useState(null);
  const [blockRunHistory, setBlockRunHistory] = useState([]);
  const [buildHistoryVisible, setBuildHistoryVisible] = useState(false);
  const blockHistoryReader = useMemo(() => createBuildHistoryReader((pid, ids) => window.flyt.getBlockHistory(pid, ids)), []);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const changed = () => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const [replyBusy, setReplyBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [stopBusy, setStopBusy] = useState(false);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [retryError, setRetryError] = useState('');
  const [workflowModels, setWorkflowModels] = useState({});
  const workflowModelsRef = useRef({});
  const activeRef = useRef(null);
  const watchingRef = useRef(null);
  const tabsRef = useRef([]);
  const flowsRef = useRef([]);
  const deckRef = useRef(null);
  const projectApi = useMemo(() => dailyProjectBridge(window.flyt), []);

  const loadWorkflowModels = useCallback(tab => {
    const next = tab?.state?.workflowModelChoices ?? {};
    workflowModelsRef.current = next;
    setWorkflowModels(next);
  }, []);

  const commitWorkflowModels = useCallback(update => {
    const next = typeof update === 'function' ? update(workflowModelsRef.current) : update;
    workflowModelsRef.current = next;
    setWorkflowModels(next);
    const projectId = activeRef.current;
    if (!projectId) return;
    const tab = tabsRef.current.find(item => item.id === projectId);
    const state = { ...(tab?.state ?? {}), workflowModelChoices: next };
    tabsRef.current = tabsRef.current.map(item => item.id === projectId ? { ...item, state } : item);
    setProjects(current => ({ ...current, tabs: current.tabs.map(item => (
      item.id === projectId ? { ...item, state } : item
    )) }));
    window.flyt.saveProjectState?.(projectId, state);
  }, []);

  const acceptProjects = useCallback(payload => {
    if (!payload) return;
    setProjects({ tabs: payload.tabs ?? [], active: payload.active ?? null });
    setTabLive(liveByProject(payload.tabs));
    activeRef.current = payload.active ?? null;
  }, []);

  const catalogRequest = useRef(0);
  const acceptWorkflows = useCallback(workflows => {
    const available = (workflows ?? []).map(workflow => ({ ...workflow, modes: workflow.presets ?? [] }));
    flowsRef.current = available;
    setFlows(available);
    setConfigs(Object.fromEntries(available.map(workflow => [workflow.id, (workflow.presets ?? []).map(preset => ({
      ...preset, badges: [],
    }))])));
    return available;
  }, []);
  const refreshWorkflows = useCallback(async () => {
    const request = ++catalogRequest.current;
    const available = await window.flyt.listWorkflows();
    if (request === catalogRequest.current) acceptWorkflows(available);
    return available ?? [];
  }, [acceptWorkflows]);

  useEffect(() => hydrateDaily(window.flyt, {
    onProjects: payload => {
      acceptProjects(payload);
      loadWorkflowModels((payload.tabs ?? []).find(tab => tab.id === payload.active));
    },
    onWorkflows: acceptWorkflows,
    onSettings: setSettings,
    onRecents: rows => setRecents(rows ?? []),
    onSelection: (payload, workflows) => {
      const active = (payload.tabs ?? []).find(tab => tab.id === payload.active);
      const openingFlowId = initialFlowId(workflows, active?.state?.runWorkflowId ?? active?.state?.runFlowId);
      setFlowId(openingFlowId);
      setModeId(initialModeId(workflows, openingFlowId, active?.state?.runPresetId ?? null));
    },
    onReady: () => setStartupReady(true),
    onError: error => setError(cleanIpcError(error)),
  }), [acceptProjects, acceptWorkflows, loadWorkflowModels]);

  useEffect(() => {
    let live = true;
    import('./buildSurface.js')
      .then(module => module.buildSurface())
      .then(surface => { if (live) setBuild(surface); })
      .catch(() => { if (live) setBuild(null); });
    return () => { live = false; };
  }, []);

  useEffect(() => build?.commands?.subscribe?.(() => setEdits(n => n + 1)), [build]);
  useEffect(() => build?.subscribePluginReview?.(() => setReviewRevision(n => n + 1)), [build]);
  useEffect(() => build?.subscribePlugins?.(() => setPluginRevision(n => n + 1)), [build]);
  useEffect(() => build?.subscribeUiExtensions?.(() => setUiExtensionRevision(n => n + 1)), [build]);
  useEffect(() => {
    if (edits || pluginRevision) refreshWorkflows().catch(err => setError(cleanIpcError(err)));
  }, [edits, pluginRevision, refreshWorkflows]);

  const refreshRuns = useCallback(async (projectId = activeRef.current) => {
    if (!projectId) { setRuns([]); return []; }
    const next = await window.flyt.listRuns(projectId);
    if (projectId === activeRef.current) setRuns(next ?? []);
    return next ?? [];
  }, []);

  useEffect(() => { refreshRuns().catch(() => setRuns([])); }, [projects.active, refreshRuns]);

  const openActivity = async row => {
    try {
      if (row.projectId && row.projectId !== activeRef.current) {
        if (tabsRef.current.some(tab => tab.id === row.projectId)) await switchProject(row.projectId);
        else await openProject(row.projectId);
        if (activeRef.current !== row.projectId) throw new Error('Open the original project to view this loop.');
      }
      if (row.kind === 'loop') setLocation(current => ({ ...current, dest: GOALS, goal: row.goalId ?? row.id }));
      else await watchRun(activeRef.current, row.id);
    } catch (caught) { setError(cleanIpcError(caught)); }
  };

  useEffect(() => {
    let live = true;
    const projectId = projects.active;
    const workflowId = build?.stack?.id;
    if (!projectId || !workflowId) { setBlockRunHistory([]); return () => { live = false; }; }
    const visible = pageVisible && buildHistoryVisible;
    blockHistoryReader.read({ projectId, workflowId, runs, visible })
      .then(rows => { if (live) setBlockRunHistory(rows); })
      .catch(() => { if (live) setBlockRunHistory([]); });
    return () => { live = false; };
  }, [projects.active, runs, build?.stack?.id, buildHistoryVisible, pageVisible, blockHistoryReader]);

  useEffect(() => window.flyt.onWorkflowEvent?.(entry => {
    if (entry?.projectId !== activeRef.current) return;
    // The retained conversation shows a single compact notice for this optional
    // recap. It must not also become a global operation-error banner.
    if (entry.code === 'optional_summary_unavailable') return;
    if (entry.kind === 'warning') { setError(entry.message ?? 'The workflow supervisor degraded.'); return; }
    if (entry.runId && watchingRef.current?.runId && entry.runId !== watchingRef.current.runId) return;
    if (entry.kind === 'approval' || entry.kind === 'question') setWorkflowInteraction(entry);
  }), []);

  const watchRun = useCallback(async (projectId, runId) => {
    if (!projectId || !runId) return;
    const [next, pending] = await Promise.all([
      readDailyRun(window.flyt, projectId, runId),
      window.flyt.getPendingWorkflowInteractions?.(projectId, runId) ?? Promise.resolve([]),
    ]);
    if (projectId !== activeRef.current) return;
    watchingRef.current = next;
    setWatching(next);
    setWorkflowInteraction((pending ?? [])[0] ?? null);
    setLocation(current => ({ ...current, dest: WORK, run: runId ?? current.run }));
  }, []);

  useEffect(() => subscribeDailyRun(window.flyt, {
    getProjectId: () => activeRef.current,
    getRunId: () => watchingRef.current?.runId,
    getWatching: () => watchingRef.current,
    onWatching: next => {
      if (!next) return;
      watchingRef.current = next;
      setWatching(next);
    },
  }), []);

  useEffect(() => window.flyt.onProjectActivity?.(({ projectId, live = [] }) => {
    setTabLive(current => ({ ...current, [projectId]: live.length }));
    if (projectId === activeRef.current) refreshRuns(projectId).catch(() => {});
  }), [refreshRuns]);

  useEffect(() => { tabsRef.current = projects.tabs; }, [projects.tabs]);
  useEffect(() => { flowsRef.current = flows; }, [flows]);
  useEffect(() => {
    const handle = ({ kind, shift }) => {
      const ids = tabsRef.current.map(tab => tab.id);
      if (ids.length < 2) return;
      if (kind === 'cycle') {
        setDeck(current => {
          const start = current?.order?.length ? current : {
            order: ids,
            index: Math.max(0, ids.indexOf(activeRef.current)),
          };
          const next = { ...start, index: (start.index + (shift ? -1 : 1) + start.order.length) % start.order.length };
          deckRef.current = next;
          return next;
        });
      } else if (kind === 'release') {
        const current = deckRef.current;
        deckRef.current = null;
        setDeck(null);
        if (current) switchProject(current.order[current.index]);
      }
    };
    const unsubscribe = window.flyt.onTabsKey?.(handle);
    return () => unsubscribe?.();
  }, []); // native stream owns the held-Ctrl interaction

  const updateFlow = useCallback((nextFlowId, modeId = null) => {
    setFlowId(nextFlowId);
    setModeId(modeId);
    const projectId = activeRef.current;
    if (!projectId) return;
    const tab = tabsRef.current.find(item => item.id === projectId);
    const state = { ...(tab?.state ?? {}), runWorkflowId: nextFlowId, runPresetId: modeId };
    tabsRef.current = tabsRef.current.map(item => item.id === projectId ? { ...item, state } : item);
    setProjects(current => ({ ...current, tabs: current.tabs.map(item => (
      item.id === projectId ? { ...item, state } : item
    )) }));
    window.flyt.saveProjectState?.(projectId, state);
  }, []);

  async function switchProject(id) {
    if (!id || id === activeRef.current) return;
    try {
      const payload = await projectApi.activateProject(id);
      acceptProjects(payload);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      loadWorkflowModels(tab);
      const nextFlowId = initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId);
      setFlowId(nextFlowId);
      setModeId(initialModeId(flowsRef.current, nextFlowId, tab?.state?.runPresetId ?? null));
      setWatching(null);
      watchingRef.current = null;
      setLocation(current => ({ ...current, run: null, goal: null }));
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function openProject(folder) {
    if (!folder) return;
    try {
      const payload = await projectApi.openProject(folder);
      acceptProjects(payload);
      setNewTabOpen(false);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      loadWorkflowModels(tab);
      const nextFlowId = initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId);
      setFlowId(nextFlowId);
      setModeId(initialModeId(flowsRef.current, nextFlowId, tab?.state?.runPresetId ?? null));
      setRecents(await window.flyt.projectRecents());
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function pickAndOpenProject() {
    const folder = await window.flyt.pickProjectFolder();
    if (folder) await openProject(folder);
  }

  async function closeProject(id) {
    try {
      const payload = await projectApi.closeProject(id);
      acceptProjects(payload);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      loadWorkflowModels(tab);
      const nextFlowId = initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId);
      setFlowId(nextFlowId);
      setModeId(initialModeId(flowsRef.current, nextFlowId, tab?.state?.runPresetId ?? null));
      if (watchingRef.current && id === projects.active) {
        watchingRef.current = null;
        setWatching(null);
        setLocation(current => ({ ...current, run: null }));
      }
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function adoptProject(id) {
    const folder = await window.flyt.pickProjectFolder();
    if (!folder) return;
    try { acceptProjects(await projectApi.adoptProject(id, folder)); }
    catch (err) { setError(cleanIpcError(err)); }
  }

  async function launch(text) {
    const originProject = activeRef.current;
    const originLocation = locationRef.current;
    const stillAtOrigin = () => locationRef.current.dest === originLocation.dest && locationRef.current.run === originLocation.run;
    if (!startupReady || !flowId || busy) return false;
    setBusy(true);
    setError('');
    try {
      let projectId = activeRef.current;
      if (!projectId) {
        const projectPayload = await window.flyt.createProject((typeof text === 'string' ? text : text.text) || 'Image conversation');
        adoptAssetDraft('launch:new', `launch:${projectPayload.opened}`);
        acceptProjects({ ...projectPayload, active: activeRef.current === originProject ? projectPayload.active : activeRef.current });
        projectId = projectPayload.opened;
        await window.flyt.saveProjectState?.(projectId, {
          runWorkflowId: flowId, runPresetId: modeId, workflowModelChoices: workflowModelsRef.current,
        });
      }
      const selectedModels = workflowModels[flowId] ?? {};
      const authoredBlockTiers = Object.fromEntries((flows.find(flow => flow.id === flowId)?.steps ?? [])
        .filter(step => step.modelBacked !== false && step.modelTier)
        .map(step => [step.id, step.modelTier]));
      const routedModels = workflowModelSelection({
        tiers: settings?.workflowModelTiers ?? {},
        defaultTier: selectedModels.defaultTier ?? DEFAULT_WORKFLOW_MODEL_TIER,
        blockTiers: selectedModels.blockTiers ?? {},
        defaultBlockTiers: authoredBlockTiers,
        customBlocks: selectedModels.customBlocks ?? {},
        fallback: settings?.workers?.executor ?? null,
      });
      const started = await window.flyt.runWorkflow(
        projectId, flowId, text, settings?.approvalMode ?? null, modeId,
        routedModels,
      );
      if (activeRef.current !== projectId || !stillAtOrigin()) return started;
      const [nextWatching, nextRuns, pending] = await Promise.all([
        readDailyRun(window.flyt, projectId, started.runId), window.flyt.listRuns(projectId),
        window.flyt.getPendingWorkflowInteractions?.(projectId, started.runId) ?? Promise.resolve([]),
      ]);
      if (activeRef.current !== projectId || !stillAtOrigin()) return started;
      setRuns(nextRuns ?? []); watchingRef.current = nextWatching; setWatching(nextWatching);
      setWorkflowInteraction((pending ?? [])[0] ?? null);
      setLocation(current => ({ ...current, dest: WORK, run: started.runId }));
      return started;
    } catch (err) { if (activeRef.current === originProject) setError(cleanIpcError(err)); throw err; }
    finally { setBusy(false); }
  }

  const newChat = useCallback(() => {
    setLocation(current => ({ ...current, dest: WORK, run: null }));
  }, []);

  const returnToRun = useCallback(() => {
    const runId = watchingRef.current?.runId;
    if (runId) setLocation(current => ({ ...current, dest: WORK, run: runId }));
  }, []);

  const activeProject = projects.tabs.find(tab => tab.id === projects.active) ?? null;
  const models = useMemo(() => (settings?.activeModels ?? []).map(model => ({
    ...settings?.modelFacts?.[model.id], ...model,
  })), [settings]);
  const selectedModels = workflowModels[flowId] ?? {};
  const defaultTier = selectedModels.defaultTier ?? DEFAULT_WORKFLOW_MODEL_TIER;
  const blockTiers = selectedModels.blockTiers ?? {};
  const modelOverrides = selectedModels.customBlocks ?? {};
  const authoredBlockTiers = Object.fromEntries((flows.find(flow => flow.id === flowId)?.steps ?? [])
    .filter(step => step.modelBacked !== false && step.modelTier)
    .map(step => [step.id, step.modelTier]));
  const setDefaultTier = tier => commitWorkflowModels(current => ({
    ...current,
    [flowId]: { ...(current[flowId] ?? {}), defaultTier: tier },
  }));
  const setStepWorker = (blockId, worker) => commitWorkflowModels(current => ({
    ...current,
    [flowId]: {
      ...(current[flowId] ?? {}),
      blockTiers: Object.fromEntries(Object.entries(current[flowId]?.blockTiers ?? {})
        .filter(([id]) => id !== blockId)),
      customBlocks: { ...(current[flowId]?.customBlocks ?? {}), [blockId]: worker },
    },
  }));
  const setStepTier = (blockId, tier = null) => commitWorkflowModels(current => {
    const nextTiers = { ...(current[flowId]?.blockTiers ?? {}) };
    const customBlocks = { ...(current[flowId]?.customBlocks ?? {}) };
    delete customBlocks[blockId];
    if (tier) nextTiers[blockId] = tier; else delete nextTiers[blockId];
    return { ...current, [flowId]: { ...(current[flowId] ?? {}), blockTiers: nextTiers, customBlocks } };
  });
  const saveModelTier = async (tier, worker, slot = 0) => {
    const next = { ...(settings?.workflowModelTiers ?? {}) };
    if (tier === 'free') {
      const current = Array.isArray(next.free) ? [...next.free] : (next.free?.model ? [next.free] : []);
      if (worker?.model) current[slot] = worker; else current.splice(slot, 1);
      if (current.length) next.free = current; else delete next.free;
    } else if (worker?.model) next[tier] = worker;
    else delete next[tier];
    try { setSettings(await window.flyt.setSettings({ workflowModelTiers: next })); }
    catch (err) { setError(cleanIpcError(err)); }
  };
  const composer = (
    <>
      {error && <p className="daily-error" role="alert">{error}</p>}
      <Lander
        projectId={projects.active}
        projectName={activeProject?.name ?? null}
        projectless={!activeProject}
        recents={recents}
        seed={activeProject?.id ?? null}
        runs={activities}
        onOpenRun={id => openActivity(activities.find(row => row.id === id) ?? { id })}
        onOpenHistory={() => setLocation(current => ({ ...current, dest: CHATS }))}
        flows={flows}
        flowId={flowId}
        modeId={modeId}
        onSelect={updateFlow}
        configs={configs}
        canonicalWorkflows
        models={models}
        activeModels={settings?.activeModels ?? []}
        hasKey={settings?.hasKey ?? true}
        claudeSubActive={settings?.claudeSubscriptionActive ?? false}
        onOpenSettings={() => setLocation(current => ({ ...current, dest: MODELS }))}
        busy={busy}
        ready={startupReady}
        onSubmit={launch}
        fallbackWorker={settings?.workers?.executor ?? null}
        modelTiers={settings?.workflowModelTiers ?? {}}
        defaultTier={defaultTier}
        blockTiers={blockTiers}
        authoredBlockTiers={authoredBlockTiers}
        modelOverrides={modelOverrides}
        onDefaultTier={setDefaultTier}
        onStepTier={setStepTier}
        onModelTier={saveModelTier}
        onStepWorker={setStepWorker}
        onResetStepWorker={blockId => setStepTier(blockId, null)}
        returnRun={watching && !location.run ? {
          name: watching.stack?.name ?? watching.snapshot?.meta?.stackId ?? 'Workflow run',
          stage: watching.snapshot?.meta?.stage ?? watching.trace?.stage ?? 'run',
        } : null}
        onReturnRun={returnToRun}
        onOpenProject={openProject}
        onOpenFolder={pickAndOpenProject}
      />
    </>
  );
  const projectTabs = (
    <TabStrip
      tabs={projects.tabs}
      activeId={projects.active}
      live={tabLive}
      saveState="saved"
      onSelect={switchProject}
      onClose={closeProject}
      onReorder={async ids => acceptProjects(await projectApi.reorderProjects(ids))}
      onNewTab={async () => { setRecents(await window.flyt.projectRecents()); setNewTabOpen(true); }}
      onRename={async (id, name) => acceptProjects(await projectApi.renameProject(id, name))}
      onAdopt={adoptProject}
      onReveal={id => projectApi.revealProject(id)}
    />
  );
  const buildView = build ? {
    ...build,
    stack: build.stack,
    history: [...(build.history ?? []), ...blockRunHistory],
    library: build.library,
    edits,
    reviewRevision,
    pluginRevision,
    uiExtensionRevision,
    pluginReview: build.pluginReview ?? null,
    // The manager's own answer, for the case where nothing pushed: a lifecycle
    // call that changed a row this window is looking at settles before the
    // change event lands, and re-reading is cheaper than guessing.
    refreshPlugins: build.plugins?.list
      ? async () => { await build.plugins.list(); setPluginRevision(n => n + 1); }
      : null,
  } : null;

  return (
    <ModelMetaProvider value={{ ...(settings ?? {}), catalog: models }}>
      <Shell
        onBuildVisibilityChange={setBuildHistoryVisible}
        activeModels={settings?.activeModels ?? []}
        projects={projects}
        location={location}
        onNavigate={setLocation}
        build={buildView}
        watching={watching}
        composer={composer}
        runs={activities}
        onOpenRun={id => openActivity(activities.find(row => row.id === id) ?? { id })}
        onNewChat={newChat}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenFlow={async () => {
          const stackId = watchingRef.current?.stack?.id;
          try {
            if (stackId && build?.stack?.id !== stackId) {
              await build?.onAct?.({ kind: 'stack', action: 'open', id: stackId });
              setEdits(n => n + 1);
            }
            setLocation(current => ({ ...current, dest: BUILD, run: current.run, workflow: stackId ?? build?.stack?.id ?? null }));
          } catch (err) { setError(cleanIpcError(err)); }
        }}
        onRetryFailed={async (blockId, guidance = '') => {
          const projectId = activeRef.current;
          const runId = watchingRef.current?.runId;
          if (!projectId || !runId || !blockId || retryBusy) return;
          setRetryBusy(true); setRetryError(''); setError('');
          try {
            await window.flyt.restartBlock(projectId, runId, blockId, guidance);
            await watchRun(projectId, runId);
            await refreshRuns(projectId);
          } catch (err) {
            const message = cleanIpcError(err);
            setRetryError(message);
            setError(message);
          } finally { setRetryBusy(false); }
        }}
        retryBusy={retryBusy}
        retryError={retryError}
        onDebugRun={async runId => {
          const projectId = activeRef.current;
          if (!projectId || !runId) throw new Error('Open a project run before starting the debugger.');
          return window.flyt.debugRun(projectId, runId);
        }}
        controlError={error}
        stopBusy={stopBusy}
        pauseBusy={pauseBusy}
        resumeBusy={resumeBusy}
        onRetryCleanup={async () => {
          const projectId = activeRef.current;
          const runId = watchingRef.current?.runId;
          if (!projectId || !runId || resumeBusy) return;
          setResumeBusy(true); setError('');
          try {
            const result = await window.flyt.retryRunCleanup(projectId, runId);
            if (result?.ok === false) throw new Error(result.message ?? 'Cleanup could not finish.');
            await watchRun(projectId, runId); await refreshRuns(projectId);
          } catch (err) { setError(cleanIpcError(err)); }
          finally { setResumeBusy(false); }
        }}
        onStopRun={async () => {
          const projectId = activeRef.current;
          const runId = watchingRef.current?.runId;
          if (!projectId || !runId || stopBusy) return;
          setStopBusy(true); setError('');
          try {
            const result = await window.flyt.stopRun(projectId, runId);
            if (result?.ok === false) throw new Error(result.message ?? result.error ?? 'The run could not be stopped.');
            setWorkflowInteraction(null);
            await watchRun(projectId, runId);
            await refreshRuns(projectId);
          } catch (err) { setError(cleanIpcError(err)); }
          finally { setStopBusy(false); }
        }}
        onPauseRun={async () => {
          const projectId = activeRef.current;
          const runId = watchingRef.current?.runId;
          if (!projectId || !runId || pauseBusy) return;
          setPauseBusy(true); setError('');
          try {
            const result = await window.flyt.pauseRun(projectId, runId);
            if (result?.ok === false) throw new Error(result.message ?? result.error ?? 'The run could not be paused.');
            await watchRun(projectId, runId);
            await refreshRuns(projectId);
          } catch (err) { setError(cleanIpcError(err)); }
          finally { setPauseBusy(false); }
        }}
        onResumeRun={async () => {
          const projectId = activeRef.current;
          const runId = watchingRef.current?.runId;
          if (!projectId || !runId || resumeBusy) return;
          setResumeBusy(true); setError('');
          try {
            const result = await window.flyt.resumeRun(projectId, runId);
            if (result?.ok === false) throw new Error(result.message ?? result.error ?? 'The run could not be resumed.');
            await watchRun(projectId, runId);
            await refreshRuns(projectId);
          } catch (err) { setError(cleanIpcError(err)); }
          finally { setResumeBusy(false); }
        }}
        onRevealRunLog={() => {
          const runId = watchingRef.current?.runId;
          if (activeRef.current && runId) window.flyt.revealRunLog?.(activeRef.current, runId);
        }}
        onRevealDiagnosticLog={() => window.flyt.revealDiagnostics?.()}
        workflowInteraction={workflowInteraction}
        onWorkflowDecide={async approved => {
          const at = workflowInteraction; if (!at) return;
          await window.flyt.decideWorkflowCall(activeRef.current, at.runId, at.callId, approved);
          setWorkflowInteraction(null);
        }}
        onWorkflowAnswer={async answer => {
          const at = workflowInteraction; if (!at) return;
          const result = await window.flyt.answerWorkflowQuestion(at.projectId, at.runId, at.questionId, answer);
          if (result?.ok === false) throw new Error(result.error);
          if (activeRef.current === at.projectId) setWorkflowInteraction(null);
          return result;
        }}
        onWorkflowReply={async text => {
          if (!watchingRef.current?.runId || replyBusy) return false;
          const projectId = activeRef.current;
          const parentRunId = watchingRef.current.runId;
          setReplyBusy(true); setError('');
          try {
            const started = await window.flyt.replyWorkflow(projectId, parentRunId, text, settings?.approvalMode ?? null);
            const [next, pending] = await Promise.all([
              readDailyRun(window.flyt, projectId, started.runId),
              window.flyt.getPendingWorkflowInteractions?.(projectId, started.runId) ?? Promise.resolve([]),
            ]);
            if (activeRef.current !== projectId || locationRef.current.run !== parentRunId || locationRef.current.dest !== WORK) return started;
            watchingRef.current = next; setWatching(next); setLocation(current => ({ ...current, dest: WORK, run: started.runId }));
            setWorkflowInteraction((pending ?? [])[0] ?? null);
            const runs = await window.flyt.listRuns(projectId);
            if (activeRef.current === projectId) setRuns(runs);
            return started;
          } catch (err) { if (activeRef.current === projectId) setError(cleanIpcError(err)); throw err; } finally { setReplyBusy(false); }
        }}
        workflowReplyBusy={replyBusy}
        onRunBuild={async stack => {
          if (!stack?.id) return;
          try {
            const available = await refreshWorkflows();
            if (!available.some(workflow => workflow.id === stack.id)) throw new Error('This workflow is not available to run. Check its validation and launchable setting.');
            updateFlow(stack.id, stack.presets?.[modeId] ? modeId : defaultModeId(stack));
            watchingRef.current = null; setWatching(null); setLocation(current => ({ ...current, dest: WORK, run: null }));
          } catch (err) { setError(cleanIpcError(err)); }
        }}
        projectTabs={projectTabs}
        models={<ModelsPage
          onChanged={() => window.flyt.getSettings().then(setSettings)}
        />}
        history={<HistoryPage onOpenLoop={openActivity} />}
        chats={<ChatHistoryPage key={projects.active} rows={activities} busy={historyState.busy} error={historyState.error} onRefresh={historyFeed.refresh} onOpen={openActivity} onNewChat={newChat}/>}
      />
      {newTabOpen && <NewTabPage
        recents={recents}
        onOpenFolder={pickAndOpenProject}
        onOpenRecent={openProject}
        onRemoveRecent={async folder => setRecents(await window.flyt.removeProjectRecent(folder))}
        onClose={() => setNewTabOpen(false)}
      />}
      {deck && <TabDeck
        order={deck.order}
        index={deck.index}
        tabs={projects.tabs}
        onPick={id => { deckRef.current = null; setDeck(null); switchProject(id); }}
        onCancel={() => { deckRef.current = null; setDeck(null); }}
        onNav={delta => setDeck(current => {
          const next = {
            ...current, index: (current.index + delta + current.order.length) % current.order.length,
          };
          deckRef.current = next;
          return next;
        })}
      />}
      {settingsOpen && <Suspense fallback={<p role="status">Opening settings…</p>}><Settings
        onClose={() => setSettingsOpen(false)}
        // Safety choices bind the NEXT run launched from here, so this state
        // has to follow the panel rather than the mount-time snapshot.
        onSaved={setSettings}
        onOpenModels={() => { setSettingsOpen(false); setLocation(current => ({ ...current, dest: MODELS })); }}
        projects={projects}
        onColorChange={async updated => {
          // The Color section's write path: the API call already persisted
          // main-side, so re-reading the project list and swapping it into
          // state is the whole update — the same merge every tab lifecycle
          // goes through, and the one the shell's theme effect watches
          // (Shell → applyProjectTheme), which is what rethemes the live
          // window with no reload. Projectless, the section renders its muted
          // state and nothing reaches here.
          if (!updated?.id) return;
          try {
            acceptProjects(await window.flyt.listProjects());
          } catch (err) { setError(cleanIpcError(err)); }
        }}
      /></Suspense>}
    </ModelMetaProvider>
  );
}
