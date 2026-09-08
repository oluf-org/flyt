// The v2 shell (t-0073). A thin view over shellRouting.js — the routing
// contract lives there so tests hold the renderer to it without importing
// React.
//
// Work is the familiar prompt-first home plus the running stack (t-0077).
// Build's body is the block editor. Library is everything installed, and the
// plugin manager that installs it. Models is the model catalog. Trace is none
// of those: it opens OVER whichever surface you are on when a run is addressed,
// and closing it puts you back. Making Trace a peer is the one thing D60 says
// it is not.
//
// The destinations live on a rail down the left rather than in the title bar.
// The title bar is the project tabs' row, and four destinations plus a tab
// strip plus the OS window controls runs out of width first.
//
// The plugin trust review is rendered at the SHELL ROOT, not inside Build.
// Installation can publish a review while somebody is on Work or Models, and a
// modal that only exists on one surface leaves that installation parked with
// nothing on screen asking about it.
//
// The shell is also the project identity host: the active project's color is
// exposed as CSS custom properties on the document root
// (src/lib/applyProjectTheme.js, consumed by src/styles/project-theme.css),
// re-applied on every active-project/color change so tabs and the two lander
// accents update without a reload, and removed when the last project closes.
import React, { useEffect, useState } from 'react';
import {
  BUILD, CHATS, GOALS, HISTORY, INITIAL, LIBRARY, MODELS, WORK, builderView, closeWorkflow, heading, navigate, openWorkflow,
  resolveLocation, state, traceOf,
} from './shellRouting.js';
import BlockEditor from './BlockEditor.jsx';
import GoalPage from './GoalPage.jsx';
import WorkflowGallery from './WorkflowGallery.jsx';
import LibraryPage from './LibraryPage.jsx';
import ShellRail from './ShellRail.jsx';
import Trace from './Trace.jsx';
import Work from './Work.jsx';
import Library from './Library.jsx';
import PluginTrustReview from './PluginTrustReview.jsx';
import { PluginContributionSection } from './PluginContributionView.jsx';
import {
  applyProjectTheme,
  clearProjectTheme,
} from '../lib/applyProjectTheme.js';

/** The active project record, when the host has one open. */
export function activeProjectRecord(projectTabsState) {
  const tabs = projectTabsState?.tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  const id = projectTabsState.active;
  if (id == null) return null;
  return tabs.find((tab) => tab?.id === id) ?? null;
}

/**
 * @param location — where the shell is, when a host is driving it. Omitted, the
 *   shell drives itself from its own state.
 *
 *   The default used to be `INITIAL` rather than `null`, and `loc` was
 *   `location ?? focus` — so the fallback could never fire, `focus` was written
 *   and never read, and every click set state that nothing rendered. The pure
 *   routing tests all passed: they call `navigate()` directly and never mount
 *   this. Found by clicking Build in a browser and watching the heading stay
 *   on Work.
 *
 * @param watching — the run being looked at: `{ runId, stack, trace }`, the
 *   trace folded by `src/traceModel.js`. Absent, Work says nothing is running
 *   and there is no Trace to open.
 * @param build — what Build edits: `{ stack, blocks, commands }`. Absent, the
 *   editor renders its empty state, which is what a project holding no stacks
 *   should look like. The HOST supplies it; the shell does not go and find one,
 *   because there is exactly one place the command surface may come from and it
 *   is not a renderer component.
 * @param onOpenSettings — the rail's foot. Absent, the rail has no utility slot
 *   rather than a button that opens nothing.
 */
export default function Shell({
  location = null, onNavigate, build = null, watching = null,
  composer = null, projectTabs = null, models = null, history = null, chats = null, onRunBuild = null,
  workflowInteraction = null, onWorkflowDecide = null, onWorkflowAnswer = null,
  onWorkflowReply = null, workflowReplyBusy = false, runs = [], onOpenRun = null,
  onNewChat = null, onOpenFlow = null, onOpenSettings = null,
  onRetryFailed = null, retryBusy = false, retryError = '', controlError = '', onRevealRunLog = null,
  onRevealDiagnosticLog = null, onRetryCleanup = null, onStopRun = null, stopBusy = false,
  onPauseRun = null, pauseBusy = false, onResumeRun = null, resumeBusy = false,
  onDebugRun = null,
  projects = { tabs: [], active: null },
}) {
  const [focus, setFocus] = useState(location ?? INITIAL);
  const loc = resolveLocation(location, focus);
  // Trace appears when anything RUNS (D60), not when somebody navigates to it.
  // A host that is watching a run has addressed one, and a location that names
  // a run has too — the second is how you reopen a finished run's record, and
  // the first is how the live one shows up without being asked for.
  const trace = traceOf(loc);
  const addressedWatching = loc.run && watching?.runId === loc.run ? watching : null;
  const here = state(loc);
  // Trace is not a destination and does not replace one: it is opened OVER
  // whichever surface you are on, and closing it puts you back where you were.
  // Making it a third tab would have been easier and would have made it a peer
  // of Work and Build, which is the one thing D60 says it is not.
  const [tracing, setTracing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const showTrace = tracing && Boolean(trace);
  useEffect(() => {
    if (!libraryOpen) return undefined;
    const closeOnEscape = event => { if (event.key === 'Escape') setLibraryOpen(false); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [libraryOpen]);

  const [makingWorkflow, setMakingWorkflow] = useState(false);
  const [workflowError, setWorkflowError] = useState('');

  // The active project's color becomes identity-only CSS custom properties on
  // the document root. Re-derived whenever the active tab or its color changes;
  // closing the last tab clears them. Records without a color use a preset.
  const activeProject = activeProjectRecord(projects);
  const activeProjectId = activeProject?.id ?? null;
  const activeProjectColor = activeProject?.colorHex ?? activeProject?.color ?? null;
  useEffect(() => {
    const mode = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    if (activeProjectId == null) {
      clearProjectTheme();
      window.flyt?.setTitleBarTheme?.(mode, null)?.catch?.(() => {});
      return undefined;
    }
    applyProjectTheme(activeProject);
    // Native window controls stay in the app's sage chrome. Project identity
    // belongs to the tab strip and the two lander accents, not the whole frame.
    window.flyt?.setTitleBarTheme?.(mode, null)?.catch?.(() => {});
    return undefined;
    // The color is a dependency so a re-colored project rethemes immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeProjectColor]);

  const move = next => {
    setTracing(false);
    setFocus(next);
    onNavigate?.(next);
    return next;
  };
  const go = dest => move(navigate(loc, dest));

  // Opening a workflow is two things that must not come apart: the host loads
  // the file, and the location says which one is being edited. Doing only the
  // first is how Build used to land you in an editor whose heading disagreed
  // with the list you pressed.
  const openStack = async id => {
    if (!id) return;
    setWorkflowError('');
    try {
      if (build?.stack?.id !== id) await build?.onAct?.({ kind: 'stack', action: 'open', id });
      move(openWorkflow(loc, id));
    } catch (error) {
      setWorkflowError(String(error?.message ?? error));
    }
  };

  const createStack = async input => {
    if (!build?.createStack) throw new Error('This host cannot create workflows');
    setMakingWorkflow(true);
    setWorkflowError('');
    try {
      const next = await build.createStack(input);
      move(openWorkflow(loc, next?.stackId ?? next?.stack?.id ?? null));
    } catch (error) {
      setWorkflowError(String(error?.message ?? error));
      throw error;
    } finally {
      setMakingWorkflow(false);
    }
  };

  const plugins = build?.library?.plugins ?? [];
  const brokenPlugins = plugins.filter(plugin => plugin.state === 'failed').length;

  return (
    <div className="v2-shell" data-v2 data-project-theme={activeProjectId != null ? '' : null}>
      <header className="v2-shell-nav" aria-label="Project">
        {projectTabs && <div className="v2-project-tabs">{projectTabs}</div>}
        <div className="v2-shell-nav-end">
          {trace && (
            <button
              type="button"
              className={'v2-trace-chip' + (showTrace ? ' active' : '')}
              onClick={() => setTracing(t => !t)}
              aria-expanded={showTrace}
              title="Open this run's record over whatever you are looking at"
            >
              Trace
            </button>
          )}
        </div>
      </header>
      <div className="v2-shell-body">
        <ShellRail
          active={showTrace ? null : loc.dest}
          onGo={go}
          onOpenSettings={onOpenSettings}
          // A plugin that failed to start is the one thing the rail interrupts
          // for: nothing else on screen will say so until somebody notices a
          // block is missing.
          badges={brokenPlugins ? { [LIBRARY]: { count: brokenPlugins, tone: 'err' } } : {}}
        />
        <section className="v2-panel" data-surface={showTrace ? 'trace' : here.surface}
          aria-label={showTrace ? 'Trace' : heading(loc.dest) ?? undefined}>
          {showTrace && <h1>Trace</h1>}
          {loc.dest !== WORK && controlError && <p className="work-error" role="alert">{controlError}</p>}
          {showTrace
            ? <Trace trace={watching?.trace ?? null} runId={trace.run} uiExtensions={build?.uiExtensions ?? []} />
            : loc.dest === GOALS
              ? <GoalPage key={`${activeProjectId}:${loc.goal ?? ''}`} projectId={activeProjectId} initialGoalId={loc.goal} onOpenRun={onOpenRun} />
            : loc.dest === CHATS
              ? chats
            : loc.dest === HISTORY
              ? history
            : loc.dest === MODELS
              ? models
              : loc.dest === LIBRARY
              ? (
                <LibraryPage
                  sources={build?.library ?? {}}
                  plugins={plugins}
                  pluginApi={build?.plugins ?? null}
                  uiExtensions={build?.uiExtensions ?? []}
                  onRefreshPlugins={build?.refreshPlugins ?? null}
                  onAct={entry => {
                    // Opening a workflow is a Build action wherever it was
                    // pressed, so the library hands you over rather than
                    // leaving you on a page whose selection just changed
                    // something you cannot see.
                    if (entry?.kind === 'stack' && entry?.action === 'open') { openStack(entry.id); return; }
                    build?.onAct?.(entry);
                  }}
                />
              )
              : loc.dest === BUILD && builderView(loc) === 'gallery'
              ? (
                <WorkflowGallery
                  stacks={build?.library?.stacks ?? []}
                  activeId={build?.stack?.id ?? null}
                  onOpen={openStack}
                  onCreate={build?.createStack ? createStack : null}
                  busy={makingWorkflow}
                  error={workflowError}
                />
              )
              : loc.dest === BUILD
              ? (
                <div className="v2-build-surface">
                  {build?.uiExtensions?.filter(row => row?.contribution?.point === 'settings-section').map(row =>
                    <PluginContributionSection key={`${row.pluginId}:${row.contribution.id}`}
                      contribution={row.contribution} pluginId={row.pluginId} />)}
                  <BlockEditor
                    onBack={() => move(closeWorkflow(loc))}
                    stack={build?.stack ?? null}
                    blocks={build?.blocks ?? null}
                    commands={build?.commands ?? null}
                    uiExtensions={build?.uiExtensions ?? []}
                    source={build?.source ?? ''}
                    validation={build?.validation ?? null}
                    history={build?.history ?? []}
                    validateSource={build?.validateSource ?? null}
                    saveSource={build?.saveSource ?? null}
                    onRun={onRunBuild ? () => onRunBuild(build?.stack) : null}
                    onOpenLibrary={() => setLibraryOpen(true)}
                  />
                  {libraryOpen && <div className="v2-library-overlay" role="presentation" onMouseDown={() => setLibraryOpen(false)}>
                    <aside className="v2-library-drawer" role="dialog" aria-modal="true" aria-labelledby="workflow-library-title"
                      onMouseDown={event => event.stopPropagation()}>
                      <div className="v2-library-drawer-head"><div><span className="section-label">BUILD</span><h2 id="workflow-library-title">Insert from the library</h2>
                        <p>The same catalog as the Library page, here so a block can go straight into this stack.</p></div>
                        <div className="v2-library-drawer-acts">
                          <button type="button" className="v2-library-drawer-open"
                            onClick={() => { setLibraryOpen(false); go(LIBRARY); }}>Open the Library</button>
                          <button type="button" className="v2-library-drawer-close" onClick={() => setLibraryOpen(false)} aria-label="Close library">×</button>
                        </div></div>
                      <Library sources={build?.library ?? {}} onAct={entry => {
                        if (entry?.kind === 'plugin') { setLibraryOpen(false); go(LIBRARY); return; }
                        build?.onAct?.(entry);
                        if (entry?.action === 'open') setLibraryOpen(false);
                      }}
                        uiExtensions={build?.uiExtensions ?? []} />
                    </aside>
                  </div>}
                </div>
              )
              : <Work
                  stack={addressedWatching?.stack ?? null}
                  blocks={build?.blocks ?? null}
                  trace={addressedWatching?.trace ?? null}
                  runId={addressedWatching?.runId ?? null}
                  snapshot={addressedWatching?.snapshot ?? null}
                  composer={composer}
                  interaction={workflowInteraction}
                  onDecide={onWorkflowDecide}
                  onAnswer={onWorkflowAnswer}
                  onReply={onWorkflowReply}
                  replyBusy={workflowReplyBusy}
                  runs={runs}
                  onOpenRun={onOpenRun}
                  onNewChat={onNewChat}
                  onOpenHistory={() => go(CHATS)}
                  onOpenFlow={onOpenFlow}
                  onOpenTrace={() => setTracing(true)}
                  onRetryFailed={onRetryFailed}
                  retryBusy={retryBusy}
                  retryError={retryError}
                  controlError={controlError}
                  onRetryCleanup={onRetryCleanup}
                  onStopRun={onStopRun}
                  stopBusy={stopBusy}
                  onPauseRun={onPauseRun}
                  pauseBusy={pauseBusy}
                  onResumeRun={onResumeRun}
                  resumeBusy={resumeBusy}
                  onRevealRunLog={onRevealRunLog}
                  onRevealDiagnosticLog={onRevealDiagnosticLog}
                  onDebugRun={onDebugRun}
                />}
        </section>
      </div>
      {/* At the root, and deliberately: a review published while somebody is on
          Work is a review nobody would ever see if this lived under Build. */}
      {build?.pluginReview?.proposals?.length > 0 && (
        <PluginTrustReview
          key={`${build.pluginReview.pluginName}:${build.pluginReview.proposals.map(p => p.name).join(',')}`}
          pluginName={build.pluginReview.pluginName}
          proposals={build.pluginReview.proposals}
          onDecide={build.pluginReview.decide}
        />
      )}
    </div>
  );
}
