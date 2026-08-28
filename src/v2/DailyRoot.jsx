import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Lander from '../Lander.jsx';
import ModelsPage from '../ModelsPage.jsx';
import Settings from '../Settings.jsx';
import TabDeck from '../TabDeck.jsx';
import TabStrip, { NewTabPage } from '../TabStrip.jsx';
import Shell from './Shell.jsx';
import { INITIAL, MODELS, WORK } from './shellRouting.js';
import { initialFlowId, watchingFromRun } from './dailyWorkModel.js';

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
  const [launchSpec, setLaunchSpec] = useState({ fields: [], declared: [] });
  const [launchValues, setLaunchValues] = useState({});
  const [declaredValues, setDeclaredValues] = useState({});
  const [settings, setSettings] = useState(null);
  const [runs, setRuns] = useState([]);
  const [watching, setWatching] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newTabOpen, setNewTabOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [tabLive, setTabLive] = useState({});
  const [deck, setDeck] = useState(null);
  const activeRef = useRef(null);
  const watchingRef = useRef(null);
  const tabsRef = useRef([]);
  const flowsRef = useRef([]);
  const deckRef = useRef(null);

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
      window.flyt.listFlows(),
      (window.flyt.listConfigs?.() ?? Promise.resolve({})).catch(() => ({})),
      window.flyt.getSettings(),
    ]).then(([projectPayload, recentProjects, availableFlows, availableConfigs, publicSettings]) => {
      if (!live) return;
      acceptProjects(projectPayload);
      setRecents(recentProjects ?? []);
      setFlows(availableFlows ?? []);
      const active = (projectPayload.tabs ?? []).find(tab => tab.id === projectPayload.active);
      setFlowId(initialFlowId(availableFlows ?? [], active?.state?.runFlowId));
      setModeId(active?.state?.runModeId ?? null);
      setConfigs(availableConfigs ?? {});
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
    if (!flowId) { setLaunchSpec({ fields: [], declared: [] }); return undefined; }
    window.flyt.flowLaunchInputs?.(flowId)
      .then(spec => { if (live) setLaunchSpec(spec ?? { fields: [], declared: [] }); })
      .catch(() => { if (live) setLaunchSpec({ fields: [], declared: [] }); });
    return () => { live = false; };
  }, [flowId]);

  const watchRun = useCallback(async (projectId, runId) => {
    if (!projectId || !runId) return;
    const [snapshot, log] = await Promise.all([
      window.flyt.getSnapshot(projectId, runId),
      window.flyt.readRunLog(projectId, runId).catch(() => []),
    ]);
    if (projectId !== activeRef.current) return;
    const next = watchingFromRun(runId, snapshot, log);
    watchingRef.current = next;
    setWatching(next);
    setLocation(current => ({ dest: WORK, run: runId ?? current.run }));
  }, []);

  useEffect(() => window.flyt.onRunUpdate?.(payload => {
    if (!payload?.runId || payload.runId !== watchingRef.current?.runId) return;
    watchRun(activeRef.current, payload.runId).catch(() => {});
  }), [watchRun]);

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
    const state = { ...(tab?.state ?? {}), runFlowId: nextFlowId, runModeId: modeId };
    setProjects(current => ({ ...current, tabs: current.tabs.map(item => (
      item.id === projectId ? { ...item, state } : item
    )) }));
    window.flyt.saveProjectState?.(projectId, state);
  }, []);

  async function switchProject(id) {
    if (!id || id === activeRef.current) return;
    try {
      const payload = await window.flyt.activateProject(id);
      acceptProjects(payload);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runFlowId));
      setModeId(tab?.state?.runModeId ?? null);
      setWatching(null);
      watchingRef.current = null;
      setLocation(current => ({ ...current, run: null }));
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function openProject(folder) {
    if (!folder) return;
    try {
      const payload = await window.flyt.openProject(folder);
      acceptProjects(payload);
      setNewTabOpen(false);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runFlowId));
      setModeId(tab?.state?.runModeId ?? null);
      setRecents(await window.flyt.projectRecents());
    } catch (err) { setError(cleanIpcError(err)); }
  }

  async function pickAndOpenProject() {
    const folder = await window.flyt.pickProjectFolder();
    if (folder) await openProject(folder);
  }

  async function closeProject(id) {
    try {
      const payload = await window.flyt.closeProject(id);
      acceptProjects(payload);
      const tab = payload.tabs?.find(item => item.id === payload.active);
      setFlowId(initialFlowId(flowsRef.current, tab?.state?.runFlowId));
      setModeId(tab?.state?.runModeId ?? null);
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
    try { acceptProjects(await window.flyt.adoptProject(id, folder)); }
    catch (err) { setError(cleanIpcError(err)); }
  }

  async function launch(text) {
    if (!flowId || busy) return;
    setBusy(true);
    setError('');
    try {
      let projectId = activeRef.current;
      if (!projectId) {
        const payload = await window.flyt.createProject(text);
        acceptProjects(payload);
        projectId = payload.opened;
      }
      const overrides = launchValues[flowId] ?? {};
      const inputs = declaredValues[flowId] ?? {};
      const launch = {
        ...(modeId ? { modeId } : {}),
        ...(Object.keys(overrides).length ? { overrides } : {}),
        ...(launchSpec.declared?.length ? { inputs } : {}),
      };
      const runId = await window.flyt.runFlow(
        projectId, flowId, text, null, settings?.approvalMode ?? null,
        Object.keys(launch).length ? launch : null,
      );
      await Promise.all([watchRun(projectId, runId), refreshRuns(projectId)]);
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
        launchInputs={launchSpec.fields ?? []}
        launchValues={launchValues[flowId] ?? {}}
        onLaunchInput={(nodeId, field, value) => setLaunchValues(current => {
          const flow = { ...(current[flowId] ?? {}) };
          const node = { ...(flow[nodeId] ?? {}) };
          if (value == null || value === '') delete node[field]; else node[field] = value;
          if (Object.keys(node).length) flow[nodeId] = node; else delete flow[nodeId];
          return { ...current, [flowId]: flow };
        })}
        declaredInputs={launchSpec.declared ?? []}
        declaredValues={declaredValues[flowId] ?? {}}
        onDeclaredInput={(name, value) => setDeclaredValues(current => ({
          ...current,
          [flowId]: { ...(current[flowId] ?? {}), [name]: value },
        }))}
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
      onReorder={async ids => acceptProjects(await window.flyt.reorderProjects(ids))}
      onNewTab={async () => { setRecents(await window.flyt.projectRecents()); setNewTabOpen(true); }}
      onRename={async (id, name) => acceptProjects(await window.flyt.renameProject(id, name))}
      onAdopt={adoptProject}
      onReveal={id => window.flyt.revealProject(id)}
    />
  );
  const buildView = build ? {
    ...build,
    stack: build.stack,
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
