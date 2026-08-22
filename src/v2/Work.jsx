// Work (t-0077): everything happening.
//
// The running stack renders as the stack you BUILT — the same `BlockEditor`,
// not a second drawing of it. Two renderings of one stack are two renderings
// that drift, and the first thing to drift would be the geometry, which is the
// one thing a person uses to recognise it.
//
// The active block is lit and its output streams inline. Parallel lanes light
// together, because they run together and an ordered list would say otherwise.
//
// Work stays calm and Trace holds the detail. The temptation here is to show
// everything, and everything is what Trace is for: what it cost, which model
// answered, what it was asked. This shows what is happening and what came out.
import React from 'react';
import BlockEditor from './BlockEditor.jsx';
import { runView } from './runView.js';
import './workStyles.css';

/**
 * @param stack — the stack being run, parsed. Absent, Work is the composer and
 *   nothing else, which is what it looks like before anything has been started.
 * @param blocks — `ctx.blocks`, so a block that is not installed draws as missing.
 * @param trace — the folded trace of the run. The SAME one Trace renders: one
 *   source, so a run watched here and watched there cannot disagree.
 * @param runId — which run, for the record.
 * @param composer — the lander, which stays the front door (D25). Passed in
 *   rather than built here: Work is where it lives, not what it is.
 */
export default function Work({ stack = null, blocks = null, trace = null, runId = null, composer = null }) {
  const view = runView(trace);

  return (
    <div className="v2-work" data-v2>
      {composer}
      {!stack && !view.running && (
        <p className="muted">Nothing is running. Compose a stack above, or open one in Build.</p>
      )}
      {stack && (
        <section className="work-run" data-running={view.running || undefined}>
          <header className="work-run-head">
            <span className="section-label">
              {view.stage ? `RUN · ${view.stage.toUpperCase()}` : 'RUN'}
            </span>
            {runId && <span className="mono work-run-id">{runId}</span>}
            {view.active.length > 1 && (
              <span className="work-lanes">{view.active.length} lanes running together</span>
            )}
          </header>
          {view.error && <p className="work-error" role="alert">{view.error}</p>}
          {/* The same editor, read-only while a run is going: editing the stack
              under a run that is walking it is a disagreement waiting to
              happen, and there is nothing this surface could do about it. */}
          <BlockEditor stack={stack} blocks={blocks} />
          <div className="work-outputs">
            {Object.entries(view.blocks).map(([blockId, block]) => (
              <article
                key={blockId}
                className={`work-block state-${block.status}`}
                data-block-id={blockId}
                data-active={block.status === 'active' || undefined}
              >
                <h3>
                  <span className="mono">{blockId}</span>
                  <span className="work-state">{block.status}</span>
                </h3>
                {block.error && <p className="work-error">{block.error}</p>}
                {block.showing
                  ? <pre className="work-output">{block.showing}</pre>
                  : <p className="muted">
                      {block.status === 'active' ? 'Working…' : 'Nothing produced yet.'}
                    </p>}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
