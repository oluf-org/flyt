// The v2 shell (t-0073). A thin view over shellRouting.js — the routing
// contract lives there so tests hold the renderer to it without importing
// React.
//
// Work is the familiar prompt-first home plus the running stack (t-0077).
// Build's body is the block editor,
// read-only until it is handed a command surface (t-0074, t-0075); the library
// is t-0076. Models is the model catalog. Trace is none of those: it opens OVER
// whichever surface you are on when a run is addressed, and closing it puts
// you back. Making Trace a peer is the one thing D60 says it is not.
import React, { useEffect, useState } from 'react';
import {
  DESTINATIONS, INITIAL, BUILD, MODELS, navigate, heading, traceOf, state, resolveLocation,
} from './shellRouting.js';
import BlockEditor from './BlockEditor.jsx';
import Trace from './Trace.jsx';
import Work from './Work.jsx';
import Library from './Library.jsx';
import PluginTrustReview from './PluginTrustReview.jsx';
import { PluginContributionSection } from './PluginContributionView.jsx';

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
 */
export default function Shell({
  location = null, onNavigate, build = null, watching = null,
  composer = null, projectTabs = null, models = null, onRunBuild = null,
  workflowInteraction = null, onWorkflowDecide = null, onWorkflowAnswer = null,
  onWorkflowReply = null, workflowReplyBusy = false, runs = [], onOpenRun = null,
}) {
  const [focus, setFocus] = useState(location ?? INITIAL);
  const loc = resolveLocation(location, focus);
  // Trace appears when anything RUNS (D60), not when somebody navigates to it.
  // A host that is watching a run has addressed one, and a location that names
  // a run has too — the second is how you reopen a finished run's record, and
  // the first is how the live one shows up without being asked for.
  const trace = traceOf(watching?.runId ? { ...loc, run: watching.runId } : loc);
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

  const go = dest => {
    const next = navigate(loc, dest);
    setTracing(false);
    setFocus(next);
    onNavigate?.(next);
  };

  return (
    <div className="v2-shell" data-v2>
      <nav className="v2-shell-nav" aria-label="v2 shell">
        {projectTabs && <div className="v2-project-tabs">{projectTabs}</div>}
        <div className="v2-destinations">
          {DESTINATIONS.map(dest => (
            <button
              key={dest}
              type="button"
              className={'v2-nav' + (loc.dest === dest && !showTrace ? ' active' : '')}
              onClick={() => go(dest)}
            >
              {heading(dest)}
            </button>
          ))}
        </div>
        {trace && (
          <button
            type="button"
            className={'v2-trace-chip' + (showTrace ? ' active' : '')}
            onClick={() => setTracing(t => !t)}
            aria-expanded={showTrace}
          >
            Trace · <span className="mono">{trace.run}</span>
          </button>
        )}
      </nav>
      <section className="v2-panel" data-surface={showTrace ? 'trace' : here.surface}>
        {showTrace && <h1>Trace</h1>}
        {showTrace
          ? <Trace trace={watching?.trace ?? null} runId={trace.run} uiExtensions={build?.uiExtensions ?? []} />
          : loc.dest === MODELS
            ? models
            : loc.dest === BUILD
            ? (
              <div className="v2-build-surface">
                {build?.uiExtensions?.filter(row => row?.contribution?.point === 'settings-section').map(row =>
                  <PluginContributionSection key={`${row.pluginId}:${row.contribution.id}`}
                    contribution={row.contribution} pluginId={row.pluginId} />)}
                <BlockEditor
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
                    <div className="v2-library-drawer-head"><div><span className="section-label">BUILD</span><h2 id="workflow-library-title">Workflow Library</h2>
                      <p>Browse reusable building blocks and project resources.</p></div>
                      <button type="button" onClick={() => setLibraryOpen(false)} aria-label="Close library">×</button></div>
                    <Library sources={build?.library ?? {}} onAct={entry => { build?.onAct?.(entry); if (entry?.action === 'open') setLibraryOpen(false); }}
                      uiExtensions={build?.uiExtensions ?? []} />
                  </aside>
                </div>}
                {build?.pluginReview?.proposals?.length > 0 && (
                  <PluginTrustReview
                    key={`${build.pluginReview.pluginName}:${build.pluginReview.proposals.map(p => p.name).join(',')}`}
                    pluginName={build.pluginReview.pluginName}
                    proposals={build.pluginReview.proposals}
                    onDecide={build.pluginReview.decide}
                  />
                )}
              </div>
            )
            : <Work
                stack={watching?.stack ?? null}
                blocks={build?.blocks ?? null}
                trace={watching?.trace ?? null}
                runId={watching?.runId ?? null}
                snapshot={watching?.snapshot ?? null}
                composer={composer}
                interaction={workflowInteraction}
                onDecide={onWorkflowDecide}
                onAnswer={onWorkflowAnswer}
                onReply={onWorkflowReply}
                replyBusy={workflowReplyBusy}
                runs={runs}
                onOpenRun={onOpenRun}
              />}
      </section>
    </div>
  );
}
