import React from 'react';
import { isTerminal } from './runProgress.js';
import { outputKey } from './runGraph.js';

// What the run actually produced, surfaced the moment it finishes (V1 task 9).
// It takes the slot the live panel vacates: while working you watch tokens,
// when finished you read the outcome. Reads the snapshot the renderer already
// has — the Output node writes the same markdown to nodes/<id>.md and result.md
// — so no new IPC and no opening the run folder to find out what happened.
export default function RunResult({ snapshot }) {
  const meta = snapshot?.meta;
  if (!meta || !isTerminal(meta.stage)) return null;

  if (meta.stage === 'failed' || meta.stage === 'rejected') {
    const failed = meta.stage === 'failed';
    return (
      <section className="result-panel" aria-label="Run outcome">
        <div className="result-head">
          <span className={'result-badge' + (failed ? ' bad' : '')}>{failed ? 'Failed' : 'Rejected'}</span>
        </div>
        <pre className="result-body">
          {meta.error || (failed
            ? 'The run stopped. Open the run folder and read log.jsonl for the full trace.'
            : 'You rejected this run at an approval gate; nothing further ran.')}
        </pre>
      </section>
    );
  }

  // A flow can declare more than one Output node; show each, labelled only when
  // there is a choice to disambiguate.
  const outputs = (snapshot.flow?.nodes ?? [])
    .filter(n => n.type === 'output')
    .map(n => ({ id: n.id, text: snapshot.nodeOutputs?.[outputKey(n.id)] }))
    .filter(o => o.text);

  return (
    <section className="result-panel" aria-label="Run result">
      <div className="result-head">
        <span className="result-badge">Done</span>
        <span className="section-label">Result</span>
      </div>
      {outputs.length
        ? outputs.map(o => (
          <div key={o.id}>
            {outputs.length > 1 && <span className="result-sub mono">{o.id}</span>}
            <pre className="result-body">{o.text}</pre>
          </div>
        ))
        : <pre className="result-body result-empty">
            This flow has no Output node, so it produced no collected result.
            Per-node outputs are on the canvas and in the run folder.
          </pre>}
    </section>
  );
}
