import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Lander from '../Lander.jsx';
import ModelsPage from '../ModelsPage.jsx';
import Settings from '../Settings.jsx';
import TabDeck from '../TabDeck.jsx';
import TabStrip, { NewTabPage } from '../TabStrip.jsx';
import Shell from './Shell.jsx';
import { INITIAL, MODELS, WORK } from './shellRouting.js';
import { initialFlowId } from './dailyWorkModel.js';
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
export default function DailyRoot() {
  const [build, setBuild] = useState(null);
  const [edits, setEdits] = useState(0);
  const [reviewRevision, setReviewRevision] = useState(0);
  const [uiExtensionRevision, setUiExtensionRevision] = useState(0);
  const [location, setLocation] = useState(INITIAL);
  const [projects, setProjects] = useState({ tabs: [], active: null });
  const [recents, setRecents] = useState([]);
  const [flows, setFlows] = useState([]);
  const [flowId, setFlowId] = useState(null);
  const [modeId, setModeId] = useState(null);
  const [configs, setConfigs] = useState({});
  const [settings, setSettings] = useState(null);
  const [runs, setRuns] = useState([]);
  const [watching, setWatching] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [tabLive, setTabLive] = useState({});
  const [deck, setDeck] = useState(null);
  const [workflowInteraction, setWorkflowInteraction] = useState(null);
  const [blockRunHistory, setBlockRunHistory] = useState([]);
  const [replyBusy, setReplyBusy] = useState(false);
  const activeRef = useRef(null);
  const watchingRef = useRef(null);
  const tabsRef = useRef([]);
  const flowsRef = useRef([]);
  const deckRef = useRef(null);
  const projectApi = useMemo(() => dailyProjectBridge(window.flyt), []);

  const acceptProjects = useCallback(payload => {
    if (!payload) return;
    setProjects({ tabs: payload.tabs ?? [], active: payload.active ?? null });
    setTabLive(liveByProject(payload.tabs));
    activeRef.current = payload.active ?? null;
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([
      window.flyt.listProjects(),
      window.flyt.projectRecents(),
      window.flyt.listWorkflows(),
      window.flyt.getSettings(),
    ]).then(([projectPayload, recentProjects, availableWorkflows, publicSettings]) => {
      if (!live) return;
      const availableFlows = (availableWorkflows ?? []).map(workflow => ({ ...workflow, modes: workflow.presets ?? [] }));
      acceptProjects(projectPayload);
      setRecents(recentProjects ?? []);
      setFlows(availableFlows);
      const active = (projectPayload.tabs ?? []).find(tab => tab.id === projectPayload.active);
      setFlowId(initialFlowId(availableFlows, active?.state?.runWorkflowId ?? active?.state?.runFlowId));
      setModeId(active?.state?.runPresetId ?? null);
      setConfigs(Object.fromEntries(availableFlows.map(workflow => [workflow.id, (workflow.presets ?? []).map(preset => ({
        ...preset, badges: [],
      }))])));
      setSettings(publicSettings);
    }).catch(err => { if (live) setError(cleanIpcError(err)); });
    return () => { live = false; };
  }, [acceptProjects]);

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
  useEffect(() => build?.subscribeUiExtensions?.(() => setUiExtensionRevision(n => n + 1)), [build]);

  const refreshRuns = useCallback(async (projectId = activeRef.current) => {
    if (!projectId) { setRuns([]); return []; }
    const next = await window.flyt.listRuns(projectId);
    if (projectId === activeRef.current) setRuns(next ?? []);
    return next ?? [];
  }, []);

  useEffect(() => { refreshRuns().catch(() => setRuns([])); }, [projects.active, refreshRuns]);

  useEffect(() => {
    let live = true;
    const projectId = projects.active;
    const workflowId = build?.stack?.id;
    if (!projectId || !workflowId) { setBlockRunHistory([]); return () => { live = false; }; }
    Promise.all((runs ?? []).slice(0, 30).map(async run => {
      try {
        const snapshot = await window.flyt.getSnapshot(projectId, run.id);
        if (snapshot?.meta?.stackId !== workflowId) return [];
        return Object.entries(snapshot.meta?.nodeStatus ?? {}).map(([nodeId, status]) => {
          const evidence = snapshot.retrospectives?.[nodeId] ?? {};
          const output = snapshot.nodeOutputs?.[nodeId];
          return {
            kind: 'run', nodeId, runId: run.id,
            command: `Run · ${status}`,
            caller: run.name ?? run.id,
            at: run.updatedAt ?? run.createdAt,
            error: evidence.error ?? (status === 'failed' ? snapshot.meta?.error : null),
            details: [
              evidence.toolCalls?.length ? `${evidence.toolCalls.length} tool call${evidence.toolCalls.length === 1 ? '' : 's'}` : '',
              Object.keys(evidence.usage ?? {}).length ? `usage ${JSON.stringify(evidence.usage)}` : '',
              output != null ? `output ${String(output).slice(0, 240)}` : '',
            ].filter(Boolean).join(' · '),
          };
        });
      } catch { return []; }
    })).then(groups => { if (live) setBlockRunHistory(groups.flat()); });
    return () => { live = false; };
  }, [projects.active, runs, build?.stack?.id]);

  useEffect(() => window.flyt.onWorkflowEvent?.(entry => {
    if (entry?.projectId !== activeRef.current) return;
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
    setLocation(current => ({ dest: WORK, run: runId ?? current.run }));
  }, []);

  useEffect(() => subscribeDailyRun(window.flyt, {
    getProjectId: () => activeRef.current,
    getRunId: () => watchingRef.current?.runId,
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
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId));
      setModeId(tab?.state?.runPresetId ?? null);
      setWatching(null);
      watchingRef.current = null;
      setLocation(current => ({ ...current, run: null }));
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function openProject(folder) {
    if (!folder) return;
    try {
      const payload = await projectApi.openProject(folder);
      acceptProjects(payload);
      setNewTabOpen(false);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId));
      setModeId(tab?.state?.runPresetId ?? null);
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
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runWorkflowId ?? tab?.state?.runFlowId));
      setModeId(tab?.state?.runPresetId ?? null);
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
    if (!flowId || busy) return;
    setBusy(true);
    setError('');
    try {
      let projectId = activeRef.current;
      if (!projectId) {
        const projectPayload = await window.flyt.createProject(text);
        acceptProjects(projectPayload);
        projectId = projectPayload.opened;
        await window.flyt.saveProjectState?.(projectId, { runWorkflowId: flowId, runPresetId: modeId });
      }
      const started = await window.flyt.runWorkflow(projectId, flowId, text, settings?.approvalMode ?? null, modeId);
      const [nextWatching, nextRuns, pending] = await Promise.all([
        readDailyRun(window.flyt, projectId, started.runId), window.flyt.listRuns(projectId),
        window.flyt.getPendingWorkflowInteractions?.(projectId, started.runId) ?? Promise.resolve([]),
      ]);
      setRuns(nextRuns ?? []); watchingRef.current = nextWatching; setWatching(nextWatching);
      setWorkflowInteraction((pending ?? [])[0] ?? null);
      setLocation({ dest: WORK, run: started.runId });
    } catch (err) { setError(cleanIpcError(err)); }
    finally { setBusy(false); }
  }

  const activeProject = projects.tabs.find(tab => tab.id === projects.active) ?? null;
  const models = useMemo(() => (settings?.activeModels ?? []).map(model => ({
    ...settings?.modelFacts?.[model.id], ...model,
  })), [settings]);
  const composer = (
    <>
      {error && <p className="daily-error" role="alert">{error}</p>}
      <Lander
        projectName={activeProject?.name ?? null}
        projectless={!activeProject}
        recents={recents}
        seed={activeProject?.id ?? null}
        runs={runs}
        onOpenRun={runId => watchRun(activeRef.current, runId).catch(err => setError(cleanIpcError(err)))}
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
        onOpenSettings={() => setSettingsOpen(true)}
        busy={busy}
        onSubmit={launch}
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
    edits,
    reviewRevision,
    uiExtensionRevision,
    pluginReview: build.pluginReview ?? null,
  } : null;

  return (
    <>
      <Shell
        location={location}
        onNavigate={setLocation}
        build={buildView}
        watching={watching}
        composer={composer}
        runs={runs}
        onOpenRun={runId => watchRun(activeRef.current, runId).catch(err => setError(cleanIpcError(err)))}
        workflowInteraction={workflowInteraction}
        onWorkflowDecide={async approved => {
          const at = workflowInteraction; if (!at) return;
          await window.flyt.decideWorkflowCall(activeRef.current, at.runId, at.callId, approved);
          setWorkflowInteraction(null);
        }}
        onWorkflowAnswer={async answer => {
          const at = workflowInteraction; if (!at) return;
          await window.flyt.answerWorkflowQuestion(activeRef.current, at.runId, at.questionId, answer);
          setWorkflowInteraction(null);
        }}
        onWorkflowReply={async text => {
          if (!watchingRef.current?.runId || replyBusy) return;
          setReplyBusy(true); setError('');
          try {
            const started = await window.flyt.replyWorkflow(activeRef.current, watchingRef.current.runId, text, settings?.approvalMode ?? null);
            const [next, pending] = await Promise.all([
              readDailyRun(window.flyt, activeRef.current, started.runId),
              window.flyt.getPendingWorkflowInteractions?.(activeRef.current, started.runId) ?? Promise.resolve([]),
            ]);
            watchingRef.current = next; setWatching(next); setLocation({ dest: WORK, run: started.runId });
            setWorkflowInteraction((pending ?? [])[0] ?? null);
            setRuns(await window.flyt.listRuns(activeRef.current));
          } catch (err) { setError(cleanIpcError(err)); } finally { setReplyBusy(false); }
        }}
        workflowReplyBusy={replyBusy}
        onRunBuild={stack => {
          if (!stack?.id) return;
          updateFlow(stack.id, stack.presets?.[modeId] ? modeId : Object.keys(stack.presets ?? {})[0] ?? null);
          watchingRef.current = null; setWatching(null); setLocation({ dest: WORK, run: null });
        }}
        projectTabs={projectTabs}
        models={<ModelsPage
          onChanged={() => window.flyt.getSettings().then(setSettings)}
          onOpenSettings={() => setSettingsOpen(true)}
        />}
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
      {settingsOpen && <Settings
        onClose={() => setSettingsOpen(false)}
        onOpenModels={() => { setSettingsOpen(false); setLocation(current => ({ ...current, dest: MODELS })); }}
      />}
    </>
  );
}
