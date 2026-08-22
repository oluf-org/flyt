// The v2 shell renderer (t-0073). A thin view over shellRouting.js — the
// routing contract lives there so tests hold the renderer to it without
// importing React. Work renders its heading only (the running stack is
// t-0077); Build's body is the block editor (t-0074), drawn read-only from
// the derived layout. The library is t-0076. Trace is transient and
// addressed by run, carried across navigation.
import React, { useState } from 'react';
import {
  DESTINATIONS, INITIAL, BUILD, navigate, heading, traceOf, state, resolveLocation,
} from './shellRouting.js';
import BlockEditor from './BlockEditor.jsx';

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
 */
export default function Shell({ location = null, onNavigate }) {
  const [focus, setFocus] = useState(location ?? INITIAL);
  const loc = resolveLocation(location, focus);
  const trace = traceOf(loc);
  const here = state(loc);

  const go = dest => {
    const next = navigate(loc, dest);
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
            className={'v2-nav' + (loc.dest === dest ? ' active' : '')}
            onClick={() => go(dest)}
          >
            {heading(dest)}
          </button>
        ))}
        {trace && (
          <span className="v2-trace-chip">
            Trace · <span className="mono">{trace.run}</span>
          </span>
        )}
      </nav>
      <section className="v2-panel" data-surface={here.surface}>
        <h1>{heading(loc.dest)}</h1>
        {loc.dest === BUILD
          ? <BlockEditor />
          : trace
            ? <p className="muted">Trace of run <span className="mono">{trace.run}</span>.</p>
            : <p className="muted">No run addressed.</p>}
      </section>
    </div>
  );
}