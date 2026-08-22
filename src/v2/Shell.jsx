// The v2 shell (t-0073). A thin view over shellRouting.js — the routing
// contract lives there so tests hold the renderer to it without importing
// React.
//
// Work is the running stack (t-0077). Build's body is the block editor,
// read-only until it is handed a command surface (t-0074, t-0075); the library
// is t-0076. Trace is neither: it opens OVER whichever surface you are on when
// a run is addressed, and closing it puts you back. A third tab would have been
// easier and would have made it a peer of the other two, which is the one thing
// D60 says it is not.
import React, { useState } from 'react';
import {
  DESTINATIONS, INITIAL, BUILD, navigate, heading, traceOf, state, resolveLocation,
} from './shellRouting.js';
import BlockEditor from './BlockEditor.jsx';
import Trace from './Trace.jsx';
import Work from './Work.jsx';

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
export default function Shell({ location = null, onNavigate, build = null, watching = null }) {
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
  const showTrace = tracing && Boolean(trace);

  const go = dest => {
    const next = navigate(loc, dest);
    setTracing(false);
    setFocus(next);
    onNavigate?.(next);
  };

  return (
    <div className="v2-shell" data-v2>
      <nav className="v2-shell-nav" aria-label="v2 shell">
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
        <h1>{showTrace ? 'Trace' : heading(loc.dest)}</h1>
        {showTrace
          ? <Trace trace={watching?.trace ?? null} runId={trace.run} />
          : loc.dest === BUILD
            ? <BlockEditor
                stack={build?.stack ?? null}
                blocks={build?.blocks ?? null}
                commands={build?.commands ?? null}
              />
            : <Work
                stack={watching?.stack ?? null}
                blocks={build?.blocks ?? null}
                trace={watching?.trace ?? null}
                runId={watching?.runId ?? null}
              />}
      </section>
    </div>
  );
}